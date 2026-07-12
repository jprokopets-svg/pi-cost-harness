/**
 * stateless-turns — force-compact + persist after every completed task.
 *
 * After each prompt completes (agent_end): compact the ENTIRE session
 * context down to system prompt + .pi-harness/project.md, then drop
 * everything else. The next prompt in the session starts near-empty
 * with only project.md as carried context.
 *
 * project.md is updated via itemized deltas (one cheap-model call) with:
 *   - Locations of key files discovered
 *   - What was learned about the codebase
 *   - Current state of the task/workspace
 *
 * Costs metered to .pi-harness/stateless_costs.jsonl.
 *
 * Config:
 *   stateless_turns: boolean (default true)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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

export default function (pi: ExtensionAPI) {
  let sessionMessages: string[] = [];

  pi.on("session_start", async () => {
    sessionMessages = [];
  });

  // Collect assistant messages for the project.md update.
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;
    const content = msg.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .slice(0, 1500);
    sessionMessages.push(text);
    return;
  });

  // Inject project.md as context at the start of each turn.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.stateless_turns === false) return {};

    const memDir = join(ctx.cwd, ".pi-harness");
    const projectPath = join(memDir, "project.md");

    if (!existsSync(projectPath)) return {};

    const projectMd = readFileSync(projectPath, "utf-8").slice(0, 8000);
    if (!projectMd.trim()) return {};

    return {
      message: {
        customType: "pi-harness-project-state",
        content: `## Project state (from prior tasks)\n${projectMd}`,
        display: false,
      },
    };
  });

  // On agent_end: update project.md with what was learned, then
  // wipe the session context by triggering a compaction.
  pi.on("agent_end", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.stateless_turns === false) return;

    if (sessionMessages.length === 0) return;

    const memDir = join(ctx.cwd, ".pi-harness");
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }

    // Write session transcript for the update script.
    const summaryPath = join(memDir, "session_summary.tmp");
    const summary = sessionMessages.slice(-8).join("\n---\n").slice(0, 4000);
    writeFileSync(summaryPath, summary);

    // Shell out to project_update.py for the cheap-model call.
    const scriptPath = join(dirname(__dirname), "scripts", "project_update.py");
    if (!existsSync(scriptPath)) return;

    try {
      execSync(`python3 "${scriptPath}" "${ctx.cwd}"`, {
        cwd: ctx.cwd,
        timeout: 25_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e: any) {
      console.error(
        `[stateless-turns] update failed: ${(e?.stderr || "").slice(0, 200)}`,
      );
    }

    // Clear session messages for next task.
    sessionMessages = [];
  });

  // Force-compact the context: on the NEXT context event after agent_end,
  // strip everything except system prompt and project.md injection.
  // This uses the session_before_compact hook to supply our own summary.
  pi.on("session_before_compact", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.stateless_turns === false) return {};

    const memDir = join(ctx.cwd, ".pi-harness");
    const projectPath = join(memDir, "project.md");
    if (!existsSync(projectPath)) return {};

    const projectMd = readFileSync(projectPath, "utf-8").slice(0, 4000);
    return {
      summary: `[Session compacted. Project state preserved in project.md.]\n\n${projectMd}`,
    };
  });
}
