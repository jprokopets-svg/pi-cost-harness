/**
 * verify-gate — detect the repo's test command; intercept task completion.
 * If tests weren't run or fail, inject a system reminder and block "done".
 *
 * Mechanism: track Bash tool calls that look like test invocations.
 * On agent_end, if no passing test run was observed, inject a follow-up
 * message asking the agent to run tests before finishing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

// Same markers as the benchmark harness's _VERIFY_MARKERS.
const VERIFY_MARKERS = [
  "pytest", "unittest", "nox", "tox", "trial",
  "npm test", "npm run test", "yarn test", "pnpm test",
  "cargo test", "go test", "mvn test", "gradle test",
  "ctest", "dart test", "flutter test", "deno test",
  "ruby -itest", "rspec", "minitest", "make test",
  "vitest", "jest",
];

function isVerifyCmd(cmd: string): boolean {
  const low = cmd.toLowerCase();
  return VERIFY_MARKERS.some((m) => low.includes(m));
}

function detectTestCommand(cwd: string): string | null {
  // pytest / python
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
    if (existsSync(join(cwd, ".venv/bin/pytest"))) {
      return ".venv/bin/pytest -x -q";
    }
    return "python -m pytest -x -q";
  }
  if (existsSync(join(cwd, "setup.py")) || existsSync(join(cwd, "setup.cfg"))) {
    return "python -m pytest -x -q";
  }

  // Node.js
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts && pkg.scripts.test) {
        return "npm test";
      }
    } catch {
      // Ignore parse errors.
    }
  }

  // Makefile
  const makefile = join(cwd, "Makefile");
  if (existsSync(makefile)) {
    try {
      const content = readFileSync(makefile, "utf-8");
      if (/^test:/m.test(content)) {
        return "make test";
      }
    } catch {
      // Ignore read errors.
    }
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) return "go test ./...";

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";

  return null;
}

function loadConfig(cwd: string): Record<string, boolean> {
  for (const p of [join(cwd, "pi-harness.config.json"), join(dirname(__dirname), "pi-harness.config.json")]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

export default function (pi: ExtensionAPI) {
  // Per-session state: did we see a passing test run?
  let testsPassed = false;
  let testsRun = false;
  let testCmd: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    testsPassed = false;
    testsRun = false;
    testCmd = detectTestCommand(ctx.cwd);
  });

  // Watch Bash tool results for test invocations.
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;

    const input = (event as any).toolCallInput;
    const cmd = input?.command || "";
    if (!isVerifyCmd(cmd)) return;

    testsRun = true;
    if (!event.isError) {
      testsPassed = true;
    }
    return;
  });

  // Intercept the agent's final message. If tests weren't run or failed,
  // send a follow-up asking the agent to verify.
  pi.on("message_end", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.verify_gate === false) return;

    // Only gate on messages that look like "I'm done" signals.
    const content = event.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ")
      .toLowerCase();

    const doneSignals = ["complete", "done", "finished", "all set", "ready for review"];
    const looksLikeDone = doneSignals.some((s) => text.includes(s));
    if (!looksLikeDone) return;

    if (testsPassed) return; // Tests ran and passed — no gate.

    const suggestion = testCmd
      ? `Run the test suite (\`${testCmd}\`) and confirm it passes before finishing.`
      : "Run the project's test suite and confirm it passes before finishing.";

    const reason = testsRun
      ? "Tests were run but did not pass."
      : "No test run was detected during this session.";

    pi.sendMessage({
      customType: "pi-harness-verify-gate",
      content: `⚠ Verify gate: ${reason} ${suggestion}`,
      display: true,
    });

    // Trigger a follow-up turn so the agent acts on the reminder.
    pi.sendUserMessage(
      `[verify-gate] ${reason} Please ${suggestion.toLowerCase()}`,
    );
  });
}
