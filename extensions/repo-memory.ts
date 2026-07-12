/**
 * repo-memory — Reflexion + Meta-Harness style sequential memory.
 *
 * Maintains two files in .pi-harness/:
 *   repo-model.md  — living codebase understanding (facts about the repo)
 *   lessons.md     — failure reflections ("assumed X; actually Y; next time Z")
 *
 * On session start: inject both files as context (capped at 2K tokens combined).
 * On agent_end: shell out to memory_update.py which makes ONE cheap-model call
 * to extract deltas (new facts + if verify failed, a Reflexion-style lesson).
 *
 * The memory-update call's tokens are metered: written to
 * .pi-harness/memory_costs.jsonl so the adapter can fold it into run cost.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

const MAX_COMBINED_CHARS = 8000; // ~2K tokens at 4 chars/token

function loadConfig(cwd: string): Record<string, any> {
  for (const p of [
    join(cwd, "pi-harness.config.json"),
    join(dirname(__dirname), "pi-harness.config.json"),
  ]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

function readMemoryFile(path: string, maxChars: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  if (content.length > maxChars) {
    // Oldest-first pruning: keep the last maxChars characters.
    return "...(pruned oldest entries)\n" + content.slice(-maxChars);
  }
  return content;
}

export default function (pi: ExtensionAPI) {
  let sessionMessages: any[] = [];
  let verifyPassed: boolean | null = null;

  pi.on("session_start", async (_event, ctx) => {
    sessionMessages = [];
    verifyPassed = null;
  });

  // Inject memory files as context on session start.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.repo_memory === false) return {};

    const memDir = join(ctx.cwd, ".pi-harness");
    const repoModelPath = join(memDir, "repo-model.md");
    const lessonsPath = join(memDir, "lessons.md");

    const halfMax = Math.floor(MAX_COMBINED_CHARS / 2);
    const repoModel = readMemoryFile(repoModelPath, halfMax);
    const lessons = readMemoryFile(lessonsPath, halfMax);

    if (!repoModel && !lessons) return {};

    const memoryContent = [
      repoModel ? `## Codebase knowledge (repo-model.md)\n${repoModel}` : "",
      lessons ? `## Lessons from prior tasks (lessons.md)\n${lessons}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      message: {
        customType: "pi-harness-repo-memory",
        content: memoryContent,
        display: false,
      },
    };
  });

  // Track tool results for verify detection.
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const input = (event as any).toolCallInput;
    const cmd = (input?.command || "").toLowerCase();
    const isVerify =
      cmd.includes("pytest") ||
      cmd.includes("runtests") ||
      cmd.includes("npm test") ||
      cmd.includes("cargo test");
    if (isVerify) {
      verifyPassed = !event.isError;
    }
    return;
  });

  // Collect assistant message summaries for the memory update.
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;
    const content = msg.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .slice(0, 2000); // cap transcript per message
    sessionMessages.push(text);
    return;
  });

  // On agent_end: shell out to memory_update.py.
  pi.on("agent_end", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.repo_memory === false) return;

    const memDir = join(ctx.cwd, ".pi-harness");
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }

    // Write session summary for the update script.
    const summaryPath = join(memDir, "session_summary.tmp");
    const summary = sessionMessages.slice(-10).join("\n---\n").slice(0, 4000);
    writeFileSync(summaryPath, summary);

    // Write verify status.
    const statusPath = join(memDir, "verify_status.tmp");
    writeFileSync(
      statusPath,
      JSON.stringify({ passed: verifyPassed }),
    );

    // Shell out to memory_update.py (makes one cheap-model call).
    const scriptPath = join(dirname(__dirname), "scripts", "memory_update.py");
    if (!existsSync(scriptPath)) return;

    try {
      execSync(`python3 "${scriptPath}" "${ctx.cwd}"`, {
        cwd: ctx.cwd,
        timeout: 30_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e: any) {
      // Don't crash the session on memory update failure.
      const stderr = e?.stderr || "";
      if (stderr) {
        console.error(`[repo-memory] update failed: ${stderr.slice(0, 200)}`);
      }
    }
  });
}
