/**
 * terse-edits — system prompt addition enforcing smallest working change.
 *
 * Prepends a directive to every turn's system prompt: make the minimal
 * diff that solves the task. No refactoring, no cleanup, no docstrings
 * on unchanged code.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const TERSE_DIRECTIVE = `
## Editing rules (pi-cost-harness/terse-edits)

Make the smallest working change. Follow these rules strictly:
- Produce the minimal diff that solves the task. No extra refactoring.
- Do not add docstrings, comments, or type annotations to code you did not change.
- Do not rename variables, reformat, or restructure code outside the fix.
- Do not add error handling for scenarios that cannot happen.
- If a one-line fix works, do not write a ten-line fix.
- Prefer editing existing files over creating new ones.
`.trim();

function loadConfig(cwd: string): Record<string, boolean> {
  for (const p of [join(cwd, "pi-harness.config.json"), join(dirname(__dirname), "pi-harness.config.json")]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.terse_edits === false) return {};

    return {
      systemPrompt: event.systemPrompt + "\n\n" + TERSE_DIRECTIVE,
    };
  });
}
