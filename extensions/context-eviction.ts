/**
 * context-eviction — attacks the 76% of pi_vanilla cost that is old tool
 * results re-sent as context every turn.
 *
 * Strategy: after N turns, large tool results are replaced with a compact
 * stub. The agent can re-run the tool if it needs the full output again.
 * This prevents the quadratic cache growth that dominates long-run cost.
 *
 * Config (pi-harness.config.json):
 *   eviction_age_turns: number of turns before a result becomes evictable (default 3)
 *   min_size_chars: minimum content size to be considered for eviction (default 500)
 *   context_eviction: boolean to enable/disable (default true)
 *
 * Never evicts:
 *   - The most recent result per unique tool+args combination
 *   - Results referenced in the last 2 assistant messages (filename/token overlap)
 *   - Edit tool results (they're small and structurally important)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

interface ToolRecord {
  toolCallId: string;
  toolName: string;
  argsSummary: string;
  firstLine: string;
  fullSize: number;
  turnIndex: number;
}

function loadConfig(cwd: string): Record<string, any> {
  for (const p of [
    join(cwd, "pi-harness.config.json"),
    join(dirname(__dirname), "pi-harness.config.json"),
  ]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

function summarizeArgs(args: any): string {
  if (!args) return "";
  if (typeof args === "string") return args.slice(0, 80);
  // For bash: show the command. For read: show the path.
  if (args.command) return args.command.slice(0, 80);
  if (args.file_path) return args.file_path;
  if (args.path) return args.path;
  return JSON.stringify(args).slice(0, 80);
}

function extractFirstLine(content: any[]): string {
  if (!Array.isArray(content)) return "(no content)";
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      const firstLine = block.text.split("\n")[0].slice(0, 120);
      return firstLine;
    }
  }
  return "(empty)";
}

function contentSize(content: any[]): number {
  if (!Array.isArray(content)) return 0;
  let size = 0;
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      size += block.text.length;
    }
  }
  return size;
}

function extractReferencedTokens(messages: any[]): Set<string> {
  // Extract filenames and identifiers from recent assistant messages
  // as a cheap heuristic for "referenced" content.
  const tokens = new Set<string>();
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "text" || !block.text) continue;
      // Extract file paths (anything with a / or .ext)
      const pathMatches = block.text.match(/[\w./\-]+\.\w{1,6}/g);
      if (pathMatches) {
        for (const m of pathMatches) tokens.add(m);
      }
      // Extract quoted identifiers
      const quotedMatches = block.text.match(/[`'"]([\w./\-]+)[`'"]/g);
      if (quotedMatches) {
        for (const m of quotedMatches) tokens.add(m.slice(1, -1));
      }
    }
  }
  return tokens;
}

export default function (pi: ExtensionAPI) {
  // Track tool results by their IDs for eviction decisions.
  const toolHistory: ToolRecord[] = [];
  let currentTurn = 0;

  pi.on("session_start", async () => {
    toolHistory.length = 0;
    currentTurn = 0;
  });

  pi.on("turn_start", async () => {
    currentTurn++;
  });

  // Record tool results as they happen.
  pi.on("tool_result", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.context_eviction === false) return;

    const content = event.content;
    const size = contentSize(content);

    toolHistory.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsSummary: summarizeArgs((event as any).toolCallInput),
      firstLine: extractFirstLine(content),
      fullSize: size,
      turnIndex: currentTurn,
    });
    return;
  });

  // Mutate the context before each LLM call: evict stale large results.
  pi.on("context", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.context_eviction === false) return;

    const evictionAge = config.eviction_age_turns ?? 3;
    const minSize = config.min_size_chars ?? 500;
    const messages = event.messages;
    if (!messages || !Array.isArray(messages)) return;

    // Find the last 2 assistant messages for reference checking.
    const recentAssistant: any[] = [];
    for (let i = messages.length - 1; i >= 0 && recentAssistant.length < 2; i--) {
      if (messages[i]?.role === "assistant") {
        recentAssistant.push(messages[i]);
      }
    }
    const referencedTokens = extractReferencedTokens(recentAssistant);

    // Track the most recent result per tool+args combo (never evict these).
    const latestByKey = new Map<string, string>();
    for (const record of toolHistory) {
      const key = `${record.toolName}:${record.argsSummary}`;
      latestByKey.set(key, record.toolCallId);
    }

    // Build the set of evictable tool call IDs.
    const evictable = new Set<string>();
    for (const record of toolHistory) {
      // Skip if too recent.
      if (currentTurn - record.turnIndex < evictionAge) continue;
      // Skip if too small.
      if (record.fullSize < minSize) continue;
      // Skip edit results (small and important).
      if (record.toolName === "edit" || record.toolName === "write") continue;
      // Skip if it's the most recent call with these args.
      const key = `${record.toolName}:${record.argsSummary}`;
      if (latestByKey.get(key) === record.toolCallId) continue;
      // Skip if referenced in recent assistant messages.
      if (referencedTokens.has(record.argsSummary)) continue;

      evictable.add(record.toolCallId);
    }

    if (evictable.size === 0) return;

    // Mutate messages: find tool_result messages and stub their content.
    let evictedCount = 0;
    for (const msg of messages) {
      if (msg?.role !== "tool") continue;
      const toolCallId = msg.tool_call_id || msg.toolCallId;
      if (!toolCallId || !evictable.has(toolCallId)) continue;

      // Find the record for this tool call.
      const record = toolHistory.find((r) => r.toolCallId === toolCallId);
      if (!record) continue;

      // Replace content with stub.
      const stub =
        `[evicted] ${record.toolName} ${record.argsSummary.slice(0, 60)} → ` +
        `${record.firstLine.slice(0, 80)}. Re-run the tool if needed.`;

      msg.content = [{ type: "text", text: stub }];
      evictedCount++;
    }

    if (evictedCount > 0) {
      return { messages };
    }
    return;
  });
}
