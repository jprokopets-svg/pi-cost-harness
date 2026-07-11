#!/usr/bin/env python3
"""Generate briefing.md for a repo — pre-computed context so the agent
can skip exploration and go straight to editing.

Self-contained: no imports from the harness. Works in any repo.

Usage:
    python scripts/briefing.py [repo_path]

Writes briefing.md to the repo root (or cwd if no path given).
"""
import ast
import re
import subprocess
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv",
             ".next", "dist", "build", ".cache", ".mypy_cache",
             ".ruff_cache", ".pytest_cache", "coverage", "htmlcov",
             ".tox", "egg-info"}


# ── Repo map ─────────────────────────────────────────────────────────────

def _format_func_sig(node):
    """Format a function signature from an ast node."""
    args = []
    for arg in node.args.args:
        name = arg.arg
        if arg.annotation:
            name += f": {ast.unparse(arg.annotation)}"
        args.append(name)
    args_str = ", ".join(args)
    ret = ""
    if node.returns:
        ret = f" -> {ast.unparse(node.returns)}"
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return f"{prefix} {node.name}({args_str}){ret}"


def _parse_python_file(filepath, rel):
    """Extract classes and function signatures from a Python file."""
    entries = []
    try:
        source = filepath.read_text(errors="ignore")
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return entries

    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.ClassDef):
            bases = ", ".join(ast.unparse(b) for b in node.bases)
            base_str = f"({bases})" if bases else ""
            entries.append(f"- `{rel}`: class {node.name}{base_str}")
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    sig = _format_func_sig(item)
                    entries.append(f"  - `{rel}`: {node.name}.{sig}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            sig = _format_func_sig(node)
            entries.append(f"- `{rel}`: {sig}")

    return entries


def _parse_generic_file(filepath, rel):
    """Regex fallback for non-Python files."""
    entries = []
    pattern = re.compile(
        r"^\s*(?:export\s+)?(?:async\s+)?"
        r"(?:def|class|function|func|fn|pub\s+fn|pub\s+struct|struct|interface|impl)\s+"
        r"(\w+)"
    )
    try:
        for line in filepath.read_text(errors="ignore").splitlines()[:500]:
            m = pattern.match(line)
            if m:
                sig = line.strip()[:120]
                entries.append(f"- `{rel}`: {sig}")
    except Exception:
        pass
    return entries


def generate_repo_map(repo, max_tokens=1500):
    """Ranked list of classes/functions with signatures."""
    max_chars = max_tokens * 4
    entries = []

    for p in sorted(repo.rglob("*")):
        if any(s in p.parts for s in SKIP_DIRS) or not p.is_file():
            continue
        rel = str(p.relative_to(repo))

        if p.suffix == ".py":
            entries.extend(_parse_python_file(p, rel))
        elif p.suffix in (".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".rb",
                          ".java", ".kt", ".swift", ".c", ".cpp", ".h"):
            entries.extend(_parse_generic_file(p, rel))

    lines = []
    char_count = 0
    for entry in entries:
        if char_count + len(entry) + 1 > max_chars:
            break
        lines.append(entry)
        char_count += len(entry) + 1

    return "\n".join(lines) if lines else "(no symbols found)"


# ── Test map ─────────────────────────────────────────────────────────────

def generate_test_map(repo, max_entries=50):
    """Map of test files and their test functions/classes.
    Capped at max_entries to keep the briefing small on large repos."""
    lines = []
    test_patterns = ("test", "spec", "__tests__")

    for p in sorted(repo.rglob("*")):
        if any(s in p.parts for s in SKIP_DIRS) or not p.is_file():
            continue
        rel = str(p.relative_to(repo))

        is_test = any(t in rel.lower() for t in test_patterns)
        if not is_test:
            continue

        if p.suffix == ".py":
            try:
                source = p.read_text(errors="ignore")
                tree = ast.parse(source)
            except (SyntaxError, ValueError):
                lines.append(f"- `{rel}` (parse error)")
                continue
            funcs = []
            for node in ast.iter_child_nodes(tree):
                if isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                    methods = [n.name for n in node.body
                               if isinstance(n, ast.FunctionDef)
                               and n.name.startswith("test")]
                    funcs.append(f"{node.name}({', '.join(methods[:5])})")
                elif isinstance(node, ast.FunctionDef) and node.name.startswith("test"):
                    funcs.append(node.name)
            if funcs:
                lines.append(f"- `{rel}`: {'; '.join(funcs)}")
            else:
                lines.append(f"- `{rel}`")
        else:
            lines.append(f"- `{rel}`")

        if len(lines) >= max_entries:
            lines.append(f"... ({max_entries}+ test files, truncated)")
            break

    return "\n".join(lines) if lines else "(no test files found)"


# ── Test command detection ───────────────────────────────────────────────

def detect_test_command(repo):
    """Detect the repo's test command from config files."""
    # pytest / python
    if (repo / "pytest.ini").exists() or (repo / "pyproject.toml").exists():
        if (repo / ".venv/bin/pytest").exists():
            return ".venv/bin/pytest -x -q"
        return "python -m pytest -x -q"

    if (repo / "setup.py").exists() or (repo / "setup.cfg").exists():
        return "python -m pytest -x -q"

    # Node.js
    pkg = repo / "package.json"
    if pkg.exists():
        try:
            import json
            data = json.loads(pkg.read_text())
            scripts = data.get("scripts", {})
            if "test" in scripts:
                return "npm test"
        except Exception:
            pass

    # Makefile
    makefile = repo / "Makefile"
    if makefile.exists():
        try:
            content = makefile.read_text(errors="ignore")
            if re.search(r"^test:", content, re.MULTILINE):
                return "make test"
        except Exception:
            pass

    # Go
    if (repo / "go.mod").exists():
        return "go test ./..."

    # Rust
    if (repo / "Cargo.toml").exists():
        return "cargo test"

    return None


# ── Git history ──────────────────────────────────────────────────────────

def recent_commits(repo, n=5):
    """Return last N commit summaries."""
    try:
        p = subprocess.run(["git", "log", f"--oneline", f"-{n}"],
                           cwd=repo, capture_output=True, text=True, timeout=10)
        return p.stdout.strip() if p.stdout.strip() else "(no git history)"
    except Exception:
        return "(git log failed)"


# ── Main ─────────────────────────────────────────────────────────────────

def generate_briefing(repo):
    """Generate the full briefing.md content."""
    sections = ["# briefing.md — pre-computed context\n",
                "Read this first. Do NOT explore the codebase; everything",
                "you need to orient is here. Go directly to editing.\n"]

    sections.append("## Repo structure (key symbols)")
    sections.append(generate_repo_map(repo))
    sections.append("")

    sections.append("## Test map")
    sections.append(generate_test_map(repo))
    sections.append("")

    test_cmd = detect_test_command(repo)
    if test_cmd:
        sections.append(f"## Test command\n`{test_cmd}`")
        sections.append("")

    sections.append("## Recent commits")
    sections.append(recent_commits(repo))

    return "\n".join(sections)


if __name__ == "__main__":
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    content = generate_briefing(repo)
    out = repo / "briefing.md"
    out.write_text(content)
    print(f"Wrote {out} ({len(content)} chars)")
