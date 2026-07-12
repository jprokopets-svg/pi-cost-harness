/**
 * horizon-context — layered context policy for long-horizon chained tasks.
 *
 * Priority-ordered layers:
 *   1. EVICT: stale tool results (>3 turns, >500 chars) → one-line stubs.
 *      Operates within a single checkpoint/invocation.
 *   2. COMPACT: only when context still exceeds 60% of window after eviction.
 *      Summarizes turns older than current checkpoint's start. Never compacts
 *      current turns, spec, plan, or memory injections.
 *   3. MEMORY: repo-model.md + lessons.md persist across checkpoints via
 *      .pi-harness/ files. Injected at each checkpoint start; updated after
 *      each checkpoint via cheap-model deltas.
 *
 * Each checkpoint is a fresh pi -p invocation (SlopCodeBench runner).
 * Cross-checkpoint continuity lives in .pi-harness/ files in the
 * carried-forward workspace, not in live context.
 *
 * Records per-checkpoint: evictions, compactions, compaction_cost, memory_cost
 * to .pi-harness/horizon_costs.jsonl.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

// ── Config ──
function loadConfig(cwd: string): Record<string, any> {
  for (const p of [
    join(cwd, "pi-harness.config.json"),
    join(dirname(__dirname), "pi-harness.config.json"),
  ]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

// ── Layer 3: Memory (cross-checkpoint) ──
function readMemoryFile(path: string, maxChars: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  if (content.length > maxChars) {
    return "...(pruned oldest)\n" + content.slice(-maxChars);
  }
  return content;
}

// ── Layer 1: Eviction state (within checkpoint) ──
interface ToolRecord {
  toolCallId: string;
  toolName: string;
  argsSummary: string;
  firstLine: string;
  fullSize: number;
  turnIndex: number;
}

function summarizeArgs(args: any): string {
  if (!args) return "";
  if (typeof args === "string") return args.slice(0, 80);
  if (args.command) return args.command.slice(0, 80);
  if (args.file_path) return args.file_path;
  return JSON.stringify(args).slice(0, 80);
}

function contentSize(content: any[]): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((s, b) => s + (b?.type === "text" ? b.text.length : 0), 0);
}

function extractFirstLine(content: any[]): string {
  if (!Array.isArray(content)) return "";
  for (const b of content) {
    if (b?.type === "text" && b.text) return b.text.split("\n")[0].slice(0, 120);
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  const toolHistory: ToolRecord[] = [];
  let currentTurn = 0;
  let evictionCount = 0;
  let compactionCount = 0;
  let lastContextTokens = 0;
  let sessionMessages: string[] = [];

  pi.on("session_start", async () => {
    toolHistory.length = 0;
    currentTurn = 0;
    evictionCount = 0;
    compactionCount = 0;
    lastContextTokens = 0;
    sessionMessages = [];
  });

  pi.on("turn_start", async () => { currentTurn++; });

  // ── Layer 3: Inject memory at checkpoint start ──
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.horizon_context === false) return {};

    const memDir = join(ctx.cwd, ".pi-harness");
    const repoModel = readMemoryFile(join(memDir, "repo-model.md"), 4000);
    const lessons = readMemoryFile(join(memDir, "lessons.md"), 2000);

    const parts: string[] = [];
    if (repoModel) parts.push(`## Codebase knowledge\n${repoModel}`);
    if (lessons) parts.push(`## Lessons from prior checkpoints\n${lessons}`);

    if (parts.length === 0) return {};

    return {
      message: {
        customType: "pi-harness-horizon-memory",
        content: parts.join("\n\n"),
        display: false,
      },
    };
  });

  // ── Layer 1: Track tool results for eviction ──
  pi.on("tool_result", async (event, _ctx) => {
    const content = event.content;
    toolHistory.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsSummary: summarizeArgs((event as any).toolCallInput),
      firstLine: extractFirstLine(content),
      fullSize: contentSize(content),
      turnIndex: currentTurn,
    });
    return;
  });

  // Track context size from assistant messages
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;
    lastContextTokens = (msg.usage?.input || 0) + (msg.usage?.cacheRead || 0);

    // Collect for memory update
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks.filter((b: any) => b.type === "text")
      .map((b: any) => b.text).join("\n").slice(0, 1500);
    if (text) sessionMessages.push(text);
    return;
  });

  // ── Layers 1+2: Evict then compact in context hook ──
  pi.on("context", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.horizon_context === false) return;

    const messages = event.messages;
    if (!messages || !Array.isArray(messages)) return;

    const evictAge = config.eviction_age_turns ?? 3;
    const minSize = config.min_size_chars ?? 500;
    const compactThreshold = config.compact_threshold ?? 0.60;
    const modelWindow = config.compact_model_window ?? 128000;

    // ── Layer 1: Eviction ──
    const protectedTypes = ["pi-harness-horizon-memory", "pi-harness-briefing"];

    // Find most recent per tool+args
    const latestByKey = new Map<string, string>();
    for (const r of toolHistory) {
      latestByKey.set(`${r.toolName}:${r.argsSummary}`, r.toolCallId);
    }

    // Recent assistant references
    const recentAssistant = messages.filter((m: any) => m.role === "assistant").slice(-2);
    const refTokens = new Set<string>();
    for (const m of recentAssistant) {
      const content = Array.isArray(m.content) ? m.content : [];
      for (const b of content) {
        if (b?.type !== "text") continue;
        const paths = b.text.match(/[\w./\-]+\.\w{1,6}/g);
        if (paths) paths.forEach((p: string) => refTokens.add(p));
      }
    }

    let evictedThisPass = 0;
    for (const record of toolHistory) {
      if (currentTurn - record.turnIndex < evictAge) continue;
      if (record.fullSize < minSize) continue;
      if (record.toolName === "edit" || record.toolName === "write") continue;
      const key = `${record.toolName}:${record.argsSummary}`;
      if (latestByKey.get(key) === record.toolCallId) continue;
      if (refTokens.has(record.argsSummary)) continue;

      // Find and stub the message
      for (const msg of messages) {
        if (msg?.role !== "tool") continue;
        const tcId = msg.tool_call_id || msg.toolCallId;
        if (tcId !== record.toolCallId) continue;
        msg.content = [{ type: "text", text:
          `[evicted] ${record.toolName} ${record.argsSummary.slice(0, 60)} → ${record.firstLine.slice(0, 80)}. Re-run if needed.`
        }];
        evictedThisPass++;
      }
    }
    if (evictedThisPass > 0) evictionCount += evictedThisPass;

    // ── Layer 2: Compact (only if still over threshold after eviction) ──
    if (lastContextTokens > modelWindow * compactThreshold && messages.length > 12) {
      compactionCount++;
      const keepFromEnd = 10;
      const first = messages[0];
      const tail = messages.slice(-keepFromEnd);
      const middle = messages.slice(1, -keepFromEnd);

      // Keep protected messages from middle
      const protectedMiddle = middle.filter(
        (m: any) => protectedTypes.includes(m.customType)
      );

      const compactMsg = {
        role: "user" as const,
        content: [{ type: "text" as const,
          text: `[Context compacted at turn ${currentTurn}. ${evictedThisPass} tool results evicted. Prior work summarized in memory files above.]`
        }],
      };

      const newMessages = [first, ...protectedMiddle, compactMsg, ...tail];
      return { messages: newMessages };
    }

    if (evictedThisPass > 0) return { messages };
    return;
  });

  // ── Layer 3: Update memory after checkpoint (agent_end) ──
  pi.on("agent_end", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.horizon_context === false) return;

    const memDir = join(ctx.cwd, ".pi-harness");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

    // Write session summary for memory_update.py
    if (sessionMessages.length > 0) {
      const summaryPath = join(memDir, "session_summary.tmp");
      writeFileSync(summaryPath, sessionMessages.slice(-8).join("\n---\n").slice(0, 4000));

      // Write verify status (check if last messages indicate pass/fail)
      const lastMsg = sessionMessages[sessionMessages.length - 1]?.toLowerCase() || "";
      const passed = lastMsg.includes("pass") || lastMsg.includes("success");
      writeFileSync(join(memDir, "verify_status.tmp"),
        JSON.stringify({ passed: passed || null }));

      const scriptPath = join(dirname(__dirname), "scripts", "memory_update.py");
      if (existsSync(scriptPath)) {
        try {
          execSync(`python3 "${scriptPath}" "${ctx.cwd}"`, {
            cwd: ctx.cwd, timeout: 25_000, encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"], env: { ...process.env },
          });
        } catch {}
      }
    }

    // Record costs for this checkpoint
    const costRecord = {
      ts: Date.now() / 1000,
      evictions: evictionCount,
      compactions: compactionCount,
    };
    const costsPath = join(memDir, "horizon_costs.jsonl");
    appendFileSync(costsPath, JSON.stringify(costRecord) + "\n");
  });
}
