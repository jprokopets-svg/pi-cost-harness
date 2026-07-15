/**
 * clean-review — after verify passes, compact to diff + test output,
 * then inject a self-review prompt for one fix-round.
 *
 * Flow:
 *   1. Watch for a passing verify (bash tool result with test markers + exit 0).
 *   2. On the NEXT message_end after verify passes (the "I'm done" message):
 *      - Run `git diff HEAD` to capture the final diff.
 *      - Compact context: drop all implementation reasoning, keep only
 *        task prompt + diff + test output.
 *      - Inject review prompt: "Review this diff as an independent reviewer."
 *   3. One review round only (don't re-trigger after the review).
 *
 * Config (pi-harness.config.json):
 *   clean_review: boolean (default true)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

const VERIFY_MARKERS = [
  "pytest", "unittest", "runtests", "npm test", "cargo test",
  "go test", "make test",
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

function isVerifyCmd(cmd: string): boolean {
  const low = cmd.toLowerCase();
  return VERIFY_MARKERS.some((m) => low.includes(m));
}

export default function (pi: ExtensionAPI) {
  let verifyPassed = false;
  let reviewTriggered = false;
  let lastVerifyOutput = "";
  let taskPrompt = "";

  pi.on("session_start", async () => {
    verifyPassed = false;
    reviewTriggered = false;
    lastVerifyOutput = "";
    taskPrompt = "";
  });

  // Capture the task prompt from the first user message.
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (!msg || msg.role !== "user" || taskPrompt) return;
    const content = msg.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    if (text.length > 50) {
      taskPrompt = text.slice(0, 2000);
    }
    return;
  });

  // Watch for passing verify runs.
  pi.on("tool_result", async (event, _ctx) => {
    if (reviewTriggered) return;
    if (event.toolName !== "bash") return;

    const input = (event as any).toolCallInput;
    const cmd = input?.command || "";
    if (!isVerifyCmd(cmd)) return;

    if (!event.isError) {
      verifyPassed = true;
      // Capture the test output.
      const content = event.content;
      if (Array.isArray(content)) {
        lastVerifyOutput = content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n")
          .slice(0, 3000);
      }
    }
    return;
  });

  // After verify passes and the agent sends its "done" message: trigger review.
  pi.on("message_end", async (event, ctx) => {
    if (reviewTriggered || !verifyPassed) return;
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const config = loadConfig(ctx.cwd);
    if (config.clean_review === false) return;

    // This is the "done" message after verify passed. Trigger the review.
    reviewTriggered = true;

    // Capture the current diff (only in git repos; stdio: "pipe" prevents
    // git's stderr from leaking into the PI process on non-git workspaces).
    let diff = "";
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: ctx.cwd, stdio: "pipe",
      });
      diff = execSync("git diff HEAD", {
        cwd: ctx.cwd,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: "pipe",
      }).slice(0, 4000);
    } catch {
      diff = "";
    }

    if (!diff.trim()) {
      // Not a git repo, or no staged changes — nothing to review.
      return;
    }

    // Inject the review prompt as a follow-up user message.
    const reviewPrompt = [
      `[CLEAN REVIEW] All tests pass. Now review your own diff as an independent reviewer.`,
      ``,
      `## Task`,
      taskPrompt.slice(0, 500),
      ``,
      `## Your diff`,
      "```diff",
      diff,
      "```",
      ``,
      `## Test output`,
      lastVerifyOutput.slice(0, 1000),
      ``,
      `## Instructions`,
      `Review for: bugs, edge cases, regressions, missed requirements.`,
      `If you find issues: fix them and re-run the verify command.`,
      `If the diff is clean: say "Review complete, no issues found."`,
      `One review round only — do not loop.`,
    ].join("\n");

    // Use streamingBehavior: 'followUp' to queue the review message rather than
    // injecting it during message_end processing (would cause "Agent is already
    // processing" and a SIGTERM crash).
    pi.sendUserMessage(reviewPrompt, { streamingBehavior: "followUp" });
  });

  // Compact context before the review round: drop implementation reasoning,
  // keep only the review prompt (which contains task + diff + test output).
  pi.on("context", async (event, ctx) => {
    if (!reviewTriggered) return;

    const config = loadConfig(ctx.cwd);
    if (config.clean_review === false) return;

    const messages = event.messages;
    if (!messages || !Array.isArray(messages)) return;

    // After review is triggered, on the NEXT context call (which serves
    // the review prompt to the LLM), strip everything except:
    // - The first message (system/task)
    // - The last 4 messages (the review prompt + any response so far)
    // This gives the reviewer a clean slate.
    const keepFromEnd = 4;
    if (messages.length <= keepFromEnd + 1) return;

    const first = messages[0];
    const tail = messages.slice(-keepFromEnd);

    const compactedMsg = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "[Prior implementation reasoning compacted for clean review.]",
        },
      ],
    };

    return { messages: [first, compactedMsg, ...tail] };
  });
}
