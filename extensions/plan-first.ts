/**
 * plan-first — for multi-file tasks, require plan.md before edits.
 *
 * Detects multi-file intent from the prompt (mentions multiple files,
 * refactor, rename, etc.). Blocks Edit/Write tool calls until a plan.md
 * has been written to the workspace.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const MULTI_FILE_SIGNALS = [
  "refactor", "rename across", "move to", "split into",
  "extract", "reorganize", "migrate", "across files",
  "multiple files", "all files", "every file",
];

function loadConfig(cwd: string): Record<string, boolean> {
  for (const p of [join(cwd, "pi-harness.config.json"), join(dirname(__dirname), "pi-harness.config.json")]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

function looksMultiFile(prompt: string): boolean {
  const low = prompt.toLowerCase();
  return MULTI_FILE_SIGNALS.some((s) => low.includes(s));
}

export default function (pi: ExtensionAPI) {
  let requirePlan = false;
  let planWritten = false;

  pi.on("session_start", async () => {
    requirePlan = false;
    planWritten = false;
  });

  // Detect multi-file intent from the user's first prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.plan_first === false) return {};

    // Check if plan.md already exists.
    if (existsSync(join(ctx.cwd, "plan.md"))) {
      planWritten = true;
    }

    // If we haven't flagged multi-file yet, check the prompt context.
    // The prompt lives in the last user message in the context.
    if (!requirePlan && !planWritten) {
      // We'll check the system prompt options for the user's query.
      // This fires on every turn, so we use a simple heuristic.
    }

    return {};
  });

  // Also detect from user input directly.
  pi.on("input", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.plan_first === false) return;

    if (typeof event.input === "string" && looksMultiFile(event.input)) {
      requirePlan = true;
    }
    return;
  });

  // Watch for plan.md being written.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "write") {
      const filePath = (event as any).toolCallInput?.file_path || "";
      if (filePath.endsWith("plan.md") && !event.isError) {
        planWritten = true;
      }
    }
    return;
  });

  // Block Edit/Write if plan is required but not yet written.
  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.plan_first === false) return;

    if (!requirePlan || planWritten) return;

    const editTools = ["edit", "write"];
    if (!editTools.includes(event.toolName)) return;

    // Allow writing plan.md itself.
    const filePath = (event as any).input?.file_path || "";
    if (filePath.endsWith("plan.md")) return;

    return {
      block: true,
      reason:
        "plan-first: This looks like a multi-file task. Write a plan.md " +
        "describing your approach before making edits. Include which files " +
        "you'll change and why.",
    };
  });

  // Inject a system prompt reminder when plan is required.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.plan_first === false) return {};

    if (!requirePlan || planWritten) return {};

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Plan-first requirement (pi-cost-harness)\n" +
        "This is a multi-file task. Before editing any files, write a plan.md " +
        "describing: (1) which files you will change, (2) what each change does, " +
        "(3) the order of changes. Edit/Write calls will be blocked until plan.md exists.",
    };
  });
}
