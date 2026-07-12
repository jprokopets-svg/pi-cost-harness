/**
 * auto-compact — trigger context compaction when usage crosses a threshold.
 *
 * Simulates real usage where people never clear context. When context
 * crosses 60% of the model window, compacts older turns into a digest
 * via one cheap-model call. Keeps verbatim: task prompt, briefing/plan,
 * last 5 turns, and repo-memory injections.
 *
 * Compaction events and their cost are recorded to
 * .pi-harness/compaction_costs.jsonl for the adapter to fold into the
 * run record (compaction_count, compaction_cost_usd).
 *
 * Config (pi-harness.config.json):
 *   auto_compact: boolean (default true)
 *   compact_threshold: number (0-1, fraction of window; default 0.60)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
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
  let turnCount = 0;
  let compactionCount = 0;
  let lastCompactionTurn = 0;

  pi.on("session_start", async () => {
    turnCount = 0;
    compactionCount = 0;
    lastCompactionTurn = 0;
  });

  // Track the latest assistant usage for threshold checking.
  let lastContextTokens = 0;

  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;
    const u = msg.usage || {};
    lastContextTokens = (u.input || 0) + (u.cacheRead || 0);
    return;
  });

  pi.on("turn_end", async (_event, ctx) => {
    turnCount++;

    const config = loadConfig(ctx.cwd);
    if (config.auto_compact === false) return;

    const threshold = config.compact_threshold ?? 0.60;

    // Don't compact if we just compacted recently (within 5 turns).
    if (turnCount - lastCompactionTurn < 5) return;
    // Don't compact if too few turns have passed.
    if (turnCount < 8) return;

    // Check context fullness from the last assistant message's usage.
    const modelWindow = config.compact_model_window ?? 128000;
    const contextTokens = lastContextTokens;

    if (contextTokens < modelWindow * threshold) return;

    // Trigger compaction: summarize old turns.
    lastCompactionTurn = turnCount;
    compactionCount++;

    const memDir = join(ctx.cwd, ".pi-harness");
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }

    // Shell out to compact_context.py for the cheap-model summarization call.
    const scriptPath = join(dirname(__dirname), "scripts", "compact_context.py");
    if (!existsSync(scriptPath)) return;

    try {
      execSync(`python3 "${scriptPath}" "${ctx.cwd}" ${turnCount}`, {
        cwd: ctx.cwd,
        timeout: 20_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e: any) {
      console.error(
        `[auto-compact] compaction failed: ${(e?.stderr || "").slice(0, 200)}`,
      );
      return;
    }

    // After the script writes the digest, trigger Pi's built-in compaction
    // with the digest as the summary. Pi's session_before_compact hook lets
    // extensions supply a custom summary.
    // For now, we just record the event — Pi doesn't expose a programmatic
    // compact trigger from turn_end. The real mechanism: the extension
    // rewrites old messages in the next `context` event.
  });

  // The actual context mutation: replace old turns with the compact digest.
  pi.on("context", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.auto_compact === false) return;

    // Only activate if a compaction was triggered.
    if (compactionCount === 0) return;

    const memDir = join(ctx.cwd, ".pi-harness");
    const digestPath = join(memDir, "compact_digest.md");
    if (!existsSync(digestPath)) return;

    const digest = readFileSync(digestPath, "utf-8");
    if (!digest.trim()) return;

    const messages = event.messages;
    if (!messages || !Array.isArray(messages)) return;

    // Keep: first message (task prompt), last 5 turns (10 messages ~),
    // and any custom messages (briefing, repo-memory).
    const keepFromEnd = 10; // ~5 turns × 2 (assistant + tool results)
    const protectedTypes = [
      "pi-harness-briefing",
      "pi-harness-repo-memory",
    ];

    if (messages.length <= keepFromEnd + 2) return; // Nothing to compact.

    // Find the boundary: keep first message + protected, compact middle,
    // keep last keepFromEnd messages.
    const firstMsg = messages[0]; // Task prompt (user message).
    const tailMessages = messages.slice(-keepFromEnd);
    const middleMessages = messages.slice(1, -keepFromEnd);

    // Filter middle: keep protected custom messages.
    const protectedMiddle = middleMessages.filter(
      (m: any) => protectedTypes.includes(m.customType),
    );

    // Replace middle with digest message.
    const digestMessage = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text:
            `[Context compacted at turn ${turnCount}. Prior work summary:]\n\n` +
            digest,
        },
      ],
    };

    const newMessages = [
      firstMsg,
      ...protectedMiddle,
      digestMessage,
      ...tailMessages,
    ];

    return { messages: newMessages };
  });
}
