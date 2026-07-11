/**
 * output-hygiene — post-process Bash tool output:
 *   1. Strip ANSI escape sequences.
 *   2. Cap at 100 lines with head/tail (keep first 50 + last 50).
 *   3. Dedupe repeated reads of the same file in context.
 *
 * Reduces token waste from verbose tool output without losing
 * signal from the head (errors/warnings) or tail (summaries).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const MAX_LINES = 100;
const HEAD_LINES = 50;
const TAIL_LINES = 50;

// Matches all common ANSI escape sequences (color, cursor, etc.).
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07|\x1b\(B/g;

function loadConfig(cwd: string): Record<string, boolean> {
  for (const p of [join(cwd, "pi-harness.config.json"), join(dirname(__dirname), "pi-harness.config.json")]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return {};
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function truncateLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;

  return [
    ...head,
    `\n... (${omitted} lines omitted) ...\n`,
    ...tail,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  // Track files already read this session to dedupe.
  const filesRead = new Set<string>();

  pi.on("session_start", async () => {
    filesRead.clear();
  });

  // Post-process Bash output: strip ANSI + truncate.
  pi.on("tool_result", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.output_hygiene === false) return;

    if (event.toolName === "bash") {
      const content = event.content;
      if (!content || !Array.isArray(content)) return;

      const modified = content.map((block: any) => {
        if (block.type !== "text") return block;
        let text = stripAnsi(block.text);
        text = truncateLines(text);
        return { ...block, text };
      });

      return { content: modified };
    }

    // Dedupe repeated file reads.
    if (event.toolName === "read") {
      const filePath = (event as any).toolCallInput?.file_path;
      if (!filePath) return;

      if (filesRead.has(filePath)) {
        return {
          content: [{
            type: "text" as const,
            text: `(file already read this session: ${filePath} — content deduplicated)`,
          }],
        };
      }
      filesRead.add(filePath);
    }

    return;
  });
}
