/**
 * script-library — reusable Python scripts as zero-cost "subagents."
 *
 * Library lives in .pi-harness/scripts/. Each entry: YAML frontmatter
 * (name, description, args, tested) + Python script body.
 *
 * Registers a Pi tool `library` with two actions:
 *   run(name, args): execute the named script, return stdout (capped 100 lines)
 *   add(name, description, script): agent contributes a new script;
 *     smoke-checked before marking tested: true.
 *
 * Seeds the library with 5 useful scripts on first run.
 * Library persists per workspace (.pi-harness/scripts/).
 * Injects a compact index into the system prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

interface ScriptEntry {
  name: string;
  description: string;
  args: string;
  tested: boolean;
  body: string;
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

function getLibDir(cwd: string): string {
  return join(cwd, ".pi-harness", "scripts");
}

function parseScript(content: string): ScriptEntry | null {
  // Parse YAML frontmatter + body.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = fmMatch[2];
  // Simple YAML parsing for known fields.
  const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() || "";
  const description = fm.match(/description:\s*(.+)/)?.[1]?.trim() || "";
  const args = fm.match(/args:\s*(.+)/)?.[1]?.trim() || "";
  const tested = fm.includes("tested: true");
  if (!name) return null;
  return { name, description, args, tested, body };
}

function loadLibrary(cwd: string): ScriptEntry[] {
  const libDir = getLibDir(cwd);
  if (!existsSync(libDir)) return [];
  const entries: ScriptEntry[] = [];
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(libDir, file), "utf-8");
    const entry = parseScript(content);
    if (entry) entries.push(entry);
  }
  return entries;
}

function seedLibrary(cwd: string): void {
  const libDir = getLibDir(cwd);
  if (!existsSync(libDir)) {
    mkdirSync(libDir, { recursive: true });
  }
  // Only seed if empty.
  const existing = readdirSync(libDir).filter((f) => f.endsWith(".md"));
  if (existing.length > 0) return;

  const seeds: Array<{ name: string; description: string; args: string; body: string }> = [
    {
      name: "repo_map",
      description: "Print a ranked list of classes/functions with signatures (top symbols)",
      args: "[max_entries=50]",
      body: `import ast, sys
from pathlib import Path

SKIP = {".git","node_modules","__pycache__",".venv","venv","dist","build"}
entries = []
repo = Path(".")
for p in sorted(repo.rglob("*.py")):
    if any(s in p.parts for s in SKIP): continue
    try:
        tree = ast.parse(p.read_text(errors="ignore"))
    except: continue
    rel = str(p)
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.ClassDef):
            entries.append(f"  {rel}: class {node.name}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            entries.append(f"  {rel}: def {node.name}")
max_e = int(sys.argv[1]) if len(sys.argv)>1 else 50
for e in entries[:max_e]: print(e)
`,
    },
    {
      name: "test_map",
      description: "List test files and their test functions/classes",
      args: "[max_entries=30]",
      body: `import ast, sys
from pathlib import Path

SKIP = {".git","node_modules","__pycache__",".venv","venv"}
entries = []
for p in sorted(Path(".").rglob("*")):
    if any(s in p.parts for s in SKIP) or not p.is_file(): continue
    rel = str(p)
    if "test" not in rel.lower(): continue
    if p.suffix == ".py":
        try:
            tree = ast.parse(p.read_text(errors="ignore"))
            funcs = [n.name for n in ast.iter_child_nodes(tree)
                     if isinstance(n, ast.FunctionDef) and n.name.startswith("test")]
            entries.append(f"  {rel}: {', '.join(funcs[:5])}")
        except:
            entries.append(f"  {rel}")
    else:
        entries.append(f"  {rel}")
max_e = int(sys.argv[1]) if len(sys.argv)>1 else 30
for e in entries[:max_e]: print(e)
`,
    },
    {
      name: "find_test_for_file",
      description: "Find test files that likely test a given source file",
      args: "<source_file>",
      body: `import sys, os
from pathlib import Path

target = sys.argv[1] if len(sys.argv) > 1 else ""
if not target:
    print("Usage: find_test_for_file <source_file>")
    sys.exit(1)

base = Path(target).stem
candidates = []
for p in Path(".").rglob("*test*"):
    if p.is_file() and base in p.name:
        candidates.append(str(p))
for p in Path(".").rglob("*test*"):
    if p.is_file() and p.suffix == ".py":
        try:
            if base in p.read_text(errors="ignore")[:2000]:
                if str(p) not in candidates:
                    candidates.append(str(p))
        except: pass

for c in candidates[:10]: print(f"  {c}")
if not candidates: print("  (no test files found)")
`,
    },
    {
      name: "failing_test_summary",
      description: "Run the verify command and summarize failures (first 50 lines of output)",
      args: "<verify_cmd>",
      body: `import subprocess, sys

cmd = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "python -m pytest -x -q"
try:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
    output = r.stdout + r.stderr
    lines = output.strip().split("\\n")
    for line in lines[:50]:
        print(line)
    if len(lines) > 50:
        print(f"  ... ({len(lines)-50} more lines)")
    print(f"  exit_code: {r.returncode}")
except subprocess.TimeoutExpired:
    print("  TIMEOUT (60s)")
except Exception as e:
    print(f"  ERROR: {e}")
`,
    },
    {
      name: "grep_symbol",
      description: "Find all occurrences of a symbol/string across the codebase",
      args: "<symbol> [file_pattern=*.py]",
      body: `import subprocess, sys

symbol = sys.argv[1] if len(sys.argv) > 1 else ""
pattern = sys.argv[2] if len(sys.argv) > 2 else "*.py"
if not symbol:
    print("Usage: grep_symbol <symbol> [file_pattern]")
    sys.exit(1)

try:
    r = subprocess.run(
        ["grep", "-rn", "--include", pattern, symbol, "."],
        capture_output=True, text=True, timeout=10)
    lines = r.stdout.strip().split("\\n")
    for line in lines[:50]:
        print(line)
    if len(lines) > 50:
        print(f"  ... ({len(lines)-50} more matches)")
except Exception as e:
    print(f"  ERROR: {e}")
`,
    },
  ];

  for (const s of seeds) {
    const content = `---
name: ${s.name}
description: ${s.description}
args: ${s.args}
tested: true
---
${s.body}`;
    writeFileSync(join(libDir, `${s.name}.md`), content);
  }
}

function runScript(cwd: string, name: string, args: string[]): string {
  const libDir = getLibDir(cwd);
  const scriptPath = join(libDir, `${name}.md`);
  if (!existsSync(scriptPath)) {
    return `Error: script '${name}' not found in library.`;
  }
  const entry = parseScript(readFileSync(scriptPath, "utf-8"));
  if (!entry) return "Error: could not parse script.";

  // Write body to temp file and execute.
  const tmpScript = join(libDir, `_run_${name}.py`);
  writeFileSync(tmpScript, entry.body);

  try {
    const argsStr = args.map((a) => `"${a}"`).join(" ");
    const output = execSync(`python3 "${tmpScript}" ${argsStr}`, {
      cwd,
      timeout: 30_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Cap at 100 lines.
    const lines = output.split("\n");
    if (lines.length > 100) {
      return [...lines.slice(0, 50), `\n... (${lines.length - 100} lines omitted)\n`, ...lines.slice(-50)].join("\n");
    }
    return output;
  } catch (e: any) {
    return `Error running ${name}: ${(e?.stderr || e?.message || "").slice(0, 200)}`;
  } finally {
    try { require("fs").unlinkSync(tmpScript); } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.script_library === false) return;
    seedLibrary(ctx.cwd);
  });

  // Inject library index into system prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.script_library === false) return {};

    const library = loadLibrary(ctx.cwd);
    if (library.length === 0) return {};

    const index = library
      .map((e) => `  - ${e.name}: ${e.description} [args: ${e.args}]`)
      .join("\n");

    const injection =
      `\n## Script library (zero-cost tools)\n` +
      `Use \`library\` tool to run these scripts instead of re-deriving the information:\n` +
      index +
      `\n\nCall: library.run(name, args) or library.add(name, description, script)`;

    return {
      systemPrompt: event.systemPrompt + injection,
    };
  });

  // Register the `library` tool.
  pi.registerTool({
    name: "library",
    description:
      "Run or add reusable Python scripts from the project's script library. " +
      "Actions: run(name, ...args) executes a script; add(name, description, script) saves a new one.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["run", "add"],
          description: "Action: 'run' to execute a script, 'add' to save a new one.",
        },
        name: {
          type: "string",
          description: "Script name (without .md extension).",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the script (for 'run' action).",
        },
        description: {
          type: "string",
          description: "One-line description (for 'add' action).",
        },
        script: {
          type: "string",
          description: "Python script body (for 'add' action).",
        },
      },
      required: ["action", "name"],
    },
    execute: async (input: any, ctx: any) => {
      const { action, name, args = [], description = "", script = "" } = input;

      if (action === "run") {
        const output = runScript(ctx.cwd, name, args);
        return { content: [{ type: "text", text: output }] };
      }

      if (action === "add") {
        if (!script.trim()) {
          return { content: [{ type: "text", text: "Error: script body is required." }], isError: true };
        }
        const libDir = getLibDir(ctx.cwd);
        if (!existsSync(libDir)) mkdirSync(libDir, { recursive: true });

        // Smoke test: run it once.
        const tmpPath = join(libDir, `_smoke_${name}.py`);
        writeFileSync(tmpPath, script);
        let tested = false;
        try {
          execSync(`python3 "${tmpPath}"`, {
            cwd: ctx.cwd, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
          });
          tested = true;
        } catch {
          // Smoke test failed — save anyway but mark untested.
        }
        try { require("fs").unlinkSync(tmpPath); } catch {}

        const content = `---\nname: ${name}\ndescription: ${description}\nargs: \ntested: ${tested}\n---\n${script}`;
        writeFileSync(join(libDir, `${name}.md`), content);

        return {
          content: [{ type: "text", text: `Script '${name}' saved (tested: ${tested}).` }],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
    },
  });
}
