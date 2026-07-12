/**
 * confidence-probe — frozen confidence elicitation at mid-loop and completion.
 *
 * Injects a confidence question at two points:
 *   1. After turn 5 (mid-loop probe): "On a scale of 0-100, how confident..."
 *   2. After the agent signals completion (final probe)
 *
 * The number is recorded but NEVER affects the loop (frozen-probe guardrail).
 * Both values are stored in a custom message for the adapter to extract.
 *
 * Config:
 *   confidence_probe: boolean (default true)
 *   confidence_midloop_turn: number (default 5)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";

const CONFIDENCE_PROMPT =
  "On a scale of 0-100, how confident are you that your current approach " +
  "will pass the task's tests? Answer with ONLY the number, nothing else.";

const DONE_SIGNALS = [
  "complete", "done", "finished", "all set", "ready for review",
  "should now pass", "tests pass", "verified",
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

function parseConfidence(text: string): number | null {
  // Extract the first number 0-100 from the response.
  const match = text.match(/\b(\d{1,3})\b/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (n < 0 || n > 100) return null;
  return n;
}

export default function (pi: ExtensionAPI) {
  let turnCount = 0;
  let midloopProbed = false;
  let finalProbed = false;
  let confMidloop: number | null = null;
  let confFinal: number | null = null;
  let awaitingConfResponse = false;
  let confType: "midloop" | "final" | null = null;

  pi.on("session_start", async () => {
    turnCount = 0;
    midloopProbed = false;
    finalProbed = false;
    confMidloop = null;
    confFinal = null;
    awaitingConfResponse = false;
    confType = null;
  });

  pi.on("message_end", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.confidence_probe === false) return;

    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    turnCount++;

    // If we're awaiting a confidence response, parse it.
    if (awaitingConfResponse && confType) {
      const content = msg.content;
      const blocks = Array.isArray(content) ? content : [];
      const text = blocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(" ");
      const conf = parseConfidence(text);

      if (confType === "midloop") {
        confMidloop = conf;
      } else {
        confFinal = conf;
      }
      awaitingConfResponse = false;
      confType = null;

      // Write to file for adapter extraction.
      const memDir = join(ctx.cwd, ".pi-harness");
      if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
      const confPath = join(memDir, "confidence.json");
      writeFileSync(confPath, JSON.stringify({
        conf_midloop: confMidloop,
        conf_final: confFinal,
      }));
      return;
    }

    // Mid-loop probe at turn N.
    const probeTurn = config.confidence_midloop_turn ?? 5;
    if (!midloopProbed && turnCount === probeTurn) {
      midloopProbed = true;
      awaitingConfResponse = true;
      confType = "midloop";
      pi.sendUserMessage(`[confidence-probe] ${CONFIDENCE_PROMPT}`);
      return;
    }

    // Final probe on completion signal.
    if (!finalProbed) {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = blocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(" ")
        .toLowerCase();

      if (DONE_SIGNALS.some((s) => text.includes(s))) {
        finalProbed = true;
        awaitingConfResponse = true;
        confType = "final";
        pi.sendUserMessage(`[confidence-probe] ${CONFIDENCE_PROMPT}`);
        return;
      }
    }
    return;
  });
}
