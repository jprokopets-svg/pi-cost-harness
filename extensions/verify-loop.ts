/**
 * verify-loop — bounded retry loop on test failure before the agent finishes.
 *
 * Stronger than verify-gate (single nudge). On completion signal:
 *   1. Run the repo's test command.
 *   2. If tests fail: feed last 30 lines back as a follow-up.
 *   3. Loop until pass or max_verify_loops (config, default 3).
 *   4. After max loops, agent must stop and report honestly.
 *
 * Records verify_loops_used in a custom message for the adapter.
 *
 * Config (pi-harness.config.json):
 *   verify_loop: boolean (default true)
 *   max_verify_loops: number (default 3)
 *   verify_cmd: string (auto-detected if absent)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

const VERIFY_MARKERS = [
  "pytest", "unittest", "runtests", "npm test", "cargo test",
  "go test", "make test", "vitest", "jest",
];

const DONE_SIGNALS = [
  "complete", "done", "finished", "all set", "ready for review",
  "changes are in place", "fix has been applied", "should now pass",
  "tests pass", "verified", "all tests pass",
];

function loadConfig(cwd: string): Record<string, any> {
  for (const p of [
    join(cwd, "pi-harness.config.json"),
    join(dirname(__dirname), "pi-harness.config.json"),
  ]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

function detectVerifyCmd(cwd: string): string | null {
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
    if (existsSync(join(cwd, ".venv/bin/pytest")))
      return ".venv/bin/pytest -x -q";
    return "python -m pytest -x -q";
  }
  if (existsSync(join(cwd, "setup.py")) || existsSync(join(cwd, "setup.cfg")))
    return "python -m pytest -x -q";
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) return "npm test";
    } catch {}
  }
  if (existsSync(join(cwd, "Makefile"))) {
    try {
      if (/^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf-8")))
        return "make test";
    } catch {}
  }
  if (existsSync(join(cwd, "go.mod"))) return "go test ./...";
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
  return null;
}

function isVerifyCmd(cmd: string): boolean {
  const low = cmd.toLowerCase();
  return VERIFY_MARKERS.some((m) => low.includes(m));
}

export default function (pi: ExtensionAPI) {
  let verifyLoopsUsed = 0;
  let verifyPassed = false;
  let inVerifyLoop = false;
  let lastTestPassed = false;

  pi.on("session_start", async () => {
    verifyLoopsUsed = 0;
    verifyPassed = false;
    inVerifyLoop = false;
    lastTestPassed = false;
  });

  // Track bash tool results for test invocations.
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const input = (event as any).toolCallInput;
    const cmd = input?.command || "";
    if (!isVerifyCmd(cmd)) return;
    lastTestPassed = !event.isError;
    if (lastTestPassed) {
      verifyPassed = true;
    }
    return;
  });

  // Intercept "I'm done" messages.
  pi.on("message_end", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.verify_loop === false) return;
    if (verifyPassed) return; // Already passed — let it finish.

    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const maxLoops = config.max_verify_loops ?? 3;
    if (verifyLoopsUsed >= maxLoops) return; // Exhausted retries.

    // Check if message looks like a completion signal.
    const content = msg.content;
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ")
      .toLowerCase();

    const looksLikeDone = DONE_SIGNALS.some((s) => text.includes(s));
    if (!looksLikeDone && !inVerifyLoop) return;

    // Run verification.
    const verifyCmd = config.verify_cmd || detectVerifyCmd(ctx.cwd);
    if (!verifyCmd) return;

    let output = "";
    let passed = false;
    try {
      output = execSync(verifyCmd, {
        cwd: ctx.cwd,
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      passed = true;
    } catch (e: any) {
      output = (e.stdout || "") + "\n" + (e.stderr || "");
      passed = false;
    }

    if (passed) {
      verifyPassed = true;
      inVerifyLoop = false;
      pi.sendMessage({
        customType: "pi-harness-verify-loop",
        content: `[verify-loop] Tests PASSED after ${verifyLoopsUsed} retry loop(s).`,
        display: true,
      });
      return;
    }

    // Tests failed — feed back if we have retries left.
    verifyLoopsUsed++;
    inVerifyLoop = true;

    if (verifyLoopsUsed >= maxLoops) {
      pi.sendMessage({
        customType: "pi-harness-verify-loop",
        content: `[verify-loop] Tests FAILED after ${verifyLoopsUsed}/${maxLoops} retries. Must stop.`,
        display: true,
      });
      pi.sendUserMessage(
        `[verify-loop] Verification failed after ${verifyLoopsUsed} attempts. ` +
        `Stop and report what you tried and why it's still failing.`,
      );
      return;
    }

    // Feed failure output back for retry.
    const lastLines = output.trim().split("\n").slice(-30).join("\n");
    pi.sendUserMessage(
      `[verify-loop ${verifyLoopsUsed}/${maxLoops}] Verification FAILED. Fix and re-verify.\n\n` +
      `Test output (last 30 lines):\n\`\`\`\n${lastLines}\n\`\`\``,
    );
  });
}
