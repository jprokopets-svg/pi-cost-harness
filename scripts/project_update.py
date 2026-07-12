#!/usr/bin/env python3
"""project_update.py — Update .pi-harness/project.md with itemized deltas.

Called by stateless-turns.ts on agent_end. Makes one cheap-model call to
extract what was learned, then appends deltas to project.md. Never rewrites
existing content (append-only with oldest-first pruning at cap).

Costs metered to .pi-harness/stateless_costs.jsonl.

Usage:
    python3 scripts/project_update.py /path/to/workspace
"""
import json
import os
import sys
import time
from pathlib import Path

import httpx


def main():
    workspace = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    mem_dir = workspace / ".pi-harness"

    summary_path = mem_dir / "session_summary.tmp"
    if not summary_path.exists():
        return

    summary = summary_path.read_text()[:4000]

    # Read existing project.md.
    project_path = mem_dir / "project.md"
    existing = project_path.read_text() if project_path.exists() else ""

    # Build prompt.
    prompt = f"""You are a project-state summarizer. Given the session transcript,
extract key information to carry forward between tasks:

1. File locations: which files are relevant and what they contain
2. Codebase patterns: testing framework, key modules, conventions
3. Current state: what was done, what was changed, final status

Output as a concise bullet list (max 10 bullets, each under 50 words).
Only add NEW facts not already in the existing state.

EXISTING PROJECT STATE (do not repeat):
{existing[:2000]}

SESSION TRANSCRIPT:
{summary}

NEW FACTS TO ADD (bullets only, or "(none)" if nothing new):"""

    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        return

    t0 = time.time()
    response = _call_deepseek(prompt, api_key)
    wall = time.time() - t0

    if not response:
        return

    content = response.get("content", "").strip()
    usage = response.get("usage", {})

    # Append new facts if any.
    if content and content.lower() != "(none)":
        new_content = existing + "\n" + content if existing else content
        # Oldest-first pruning at 16K chars.
        if len(new_content) > 16000:
            new_content = new_content[-16000:]
            nl = new_content.find("\n")
            if nl > 0:
                new_content = new_content[nl + 1:]
        project_path.write_text(new_content)

    # Record cost.
    cost_record = {
        "ts": time.time(),
        "wall_time_s": wall,
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cost_usd": _compute_cost(usage),
    }
    costs_path = mem_dir / "stateless_costs.jsonl"
    with open(costs_path, "a") as f:
        f.write(json.dumps(cost_record) + "\n")

    # Clean up.
    summary_path.unlink(missing_ok=True)


def _call_deepseek(prompt: str, api_key: str) -> dict | None:
    try:
        response = httpx.post(
            "https://api.deepseek.com/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 400,
                "temperature": 0.3,
            },
            timeout=20.0,
        )
        response.raise_for_status()
        data = response.json()
        choice = data["choices"][0]["message"]
        return {
            "content": choice.get("content", ""),
            "usage": data.get("usage", {}),
        }
    except Exception as e:
        print(f"[project_update] API call failed: {e}", file=sys.stderr)
        return None


def _compute_cost(usage: dict) -> float:
    inp = usage.get("prompt_tokens", 0)
    out = usage.get("completion_tokens", 0)
    return (inp * 0.14 + out * 0.28) / 1e6


if __name__ == "__main__":
    main()
