/**
 * step-verify — verification with bounded retry for chained workloads.
 *
 * Trigger: AGENT IDLE — turn ends with no tool call and no passing verify
 * in the current checkpoint's transcript. NOT keyword-based.
 *
 * Uses the problem's visible test entry points only — never invokes
 * slop-code eval or the harness's own evaluation machinery.
 *
 * Config:
 *   step_verify: boolean (default true)
 *   max_verify_loops: number (default 3)
 *   verify_cmd: string (optional; auto-detected if absent)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

function loadConfig(cwd: string): Record<string, any> {
  for (const p of [
    join(cwd, "pi-harness.config.json"),
    join(dirname(__dirname), "pi-harness.config.json"),
  ]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

// Auto-detect verify command from workspace
function detectVerifyCmd(cwd: string): string | null {
  // SlopCodeBench problems: look for entry_file pattern
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini")))
    return "python -m pytest -x -q";
  if (existsSync(join(cwd, "requirements.txt")))
    return "python -m pytest -x -q";
  return null;
}

const VERIFY_MARKERS = ["pytest", "unittest", "python -m pytest"];

function isVerifyCmd(cmd: string): boolean {
  return VERIFY_MARKERS.some((m) => cmd.toLowerCase().includes(m));
}

export default function (pi: ExtensionAPI) {
  let verifyPassed = false;
  let verifyLoopsUsed = 0;
  let lastTurnHadToolCall = false;
  let turnCount = 0;

  pi.on("session_start", async () => {
    verifyPassed = false;
    verifyLoopsUsed = 0;
    lastTurnHadToolCall = false;
    turnCount = 0;
  });

  // Track tool calls to detect "idle" turns (no tool call = agent thinks it's done)
  pi.on("tool_execution_end", async () => {
    lastTurnHadToolCall = true;
  });

  // Track verify results from agent's own test runs
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;
    const cmd = ((event as any).toolCallInput?.command || "").toLowerCase();
    if (isVerifyCmd(cmd) && !event.isError) {
      verifyPassed = true;
    }
    return;
  });

  // On turn end: check for idle (no tool call) without passing verify
  pi.on("turn_end", async (_event, ctx) => {
    turnCount++;
    const config = loadConfig(ctx.cwd);
    if (config.step_verify === false) return;
    if (verifyPassed) return;

    const maxLoops = config.max_verify_loops ?? 3;
    if (verifyLoopsUsed >= maxLoops) return;

    // Only trigger after the agent has had a few turns to work
    if (turnCount < 3) {
      lastTurnHadToolCall = false;
      return;
    }

    // Idle detection: no tool call this turn = agent thinks it's done
    if (lastTurnHadToolCall) {
      lastTurnHadToolCall = false;
      return;
    }
    lastTurnHadToolCall = false;

    // Agent is idle without a passing verify. Run verification.
    const verifyCmd = config.verify_cmd || detectVerifyCmd(ctx.cwd);
    if (!verifyCmd) return;

    let output = "";
    let passed = false;
    try {
      output = execSync(verifyCmd, {
        cwd: ctx.cwd, encoding: "utf-8", timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      passed = true;
    } catch (e: any) {
      output = (e.stdout || "") + "\n" + (e.stderr || "");
    }

    if (passed) {
      verifyPassed = true;
      return;
    }

    verifyLoopsUsed++;
    // Use streamingBehavior: 'followUp' so the message is queued rather than
    // injected while turn_end is still being processed. Without this, PI throws
    // "Agent is already processing" and kills itself with SIGTERM.
    if (verifyLoopsUsed >= maxLoops) {
      pi.sendUserMessage(
        `[step-verify] Tests FAILED after ${verifyLoopsUsed}/${maxLoops} attempts. ` +
        `Report what you tried and why it's still failing, then stop.`,
        { streamingBehavior: "followUp" }
      );
    } else {
      const lastLines = output.trim().split("\n").slice(-30).join("\n");
      pi.sendUserMessage(
        `[step-verify ${verifyLoopsUsed}/${maxLoops}] Tests FAILED. Fix and try again.\n\n` +
        `\`\`\`\n${lastLines}\n\`\`\``,
        { streamingBehavior: "followUp" }
      );
    }

    // Record
    const memDir = join(ctx.cwd, ".pi-harness");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
    appendFileSync(join(memDir, "horizon_costs.jsonl"),
      JSON.stringify({ ts: Date.now() / 1000, verify_loops_used: verifyLoopsUsed }) + "\n");
  });
}
