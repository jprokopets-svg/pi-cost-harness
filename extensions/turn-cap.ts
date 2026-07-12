/**
 * turn-cap — abort the session after N assistant turns.
 *
 * Config (pi-harness.config.json):
 *   turn_cap: number (max assistant turns before abort; default: none/unlimited)
 *
 * When the cap is hit, sends a "budget exceeded" user message and the
 * agent stops. The adapter records budget_exceeded from the raw output.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

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
  let capped = false;

  pi.on("session_start", async () => {
    turnCount = 0;
    capped = false;
  });

  pi.on("message_end", async (event, ctx) => {
    if (capped) return;
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    turnCount++;

    const config = loadConfig(ctx.cwd);
    const cap = config.turn_cap;
    if (!cap || turnCount < cap) return;

    // Cap reached — signal stop.
    capped = true;
    pi.sendMessage({
      customType: "pi-harness-turn-cap",
      content: `[turn-cap] Budget exceeded: ${turnCount}/${cap} turns used. Stopping.`,
      display: true,
    });
    // Send a user message that tells the agent to stop.
    pi.sendUserMessage(
      "[BUDGET EXCEEDED] You have used all allocated turns. Stop immediately and report current status.",
    );
    return;
  });
}
