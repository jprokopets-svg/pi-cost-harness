#!/usr/bin/env python3
"""compact_context.py — ONE cheap-model call to summarize prior turns.

Called by auto-compact.ts when context crosses the threshold.
Reads the current compact_digest.md (if any) and appends new work since
last compaction. Writes cost to .pi-harness/compaction_costs.jsonl.

Usage:
    python3 scripts/compact_context.py /path/to/workspace <turn_number>
"""
import json
import os
import sys
import time
from pathlib import Path

import httpx


def main():
    workspace = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    turn_number = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    mem_dir = workspace / ".pi-harness"
    mem_dir.mkdir(parents=True, exist_ok=True)

    # Read existing digest.
    digest_path = mem_dir / "compact_digest.md"
    existing_digest = digest_path.read_text() if digest_path.exists() else ""

    # Read session summary (written by repo-memory or standalone).
    summary_path = mem_dir / "session_summary.tmp"
    recent_work = ""
    if summary_path.exists():
        recent_work = summary_path.read_text()[:3000]

    # If no recent work to summarize, read git log for what changed.
    if not recent_work:
        try:
            import subprocess
            result = subprocess.run(
                ["git", "log", "--oneline", "-5"],
                cwd=workspace, capture_output=True, text=True, timeout=5,
            )
            recent_work = f"Recent git commits:\n{result.stdout}" if result.stdout else ""
        except Exception:
            pass

    if not recent_work and not existing_digest:
        return  # Nothing to compact.

    # Build the compaction prompt.
    prompt = f"""Summarize the following session activity into a compact digest (max 500 words).
Focus on: what files were changed, what was tried, what worked/failed, current state.
Do NOT include code — only describe what happened.

EXISTING DIGEST (prior compactions):
{existing_digest[:2000] if existing_digest else "(none)"}

NEW ACTIVITY SINCE LAST COMPACTION:
{recent_work}

Write a concise updated digest:"""

    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        return

    t0 = time.time()
    response = _call_deepseek(prompt, api_key)
    wall = time.time() - t0

    if not response:
        return

    new_digest = response.get("content", "")
    usage = response.get("usage", {})

    # Write updated digest.
    if new_digest.strip():
        digest_path.write_text(new_digest.strip())

    # Record cost.
    cost_record = {
        "ts": time.time(),
        "turn": turn_number,
        "wall_time_s": wall,
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cost_usd": _compute_cost(usage),
    }
    costs_path = mem_dir / "compaction_costs.jsonl"
    with open(costs_path, "a") as f:
        f.write(json.dumps(cost_record) + "\n")


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
                "max_tokens": 500,
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
        print(f"[compact_context] API call failed: {e}", file=sys.stderr)
        return None


def _compute_cost(usage: dict) -> float:
    inp = usage.get("prompt_tokens", 0)
    out = usage.get("completion_tokens", 0)
    return (inp * 0.14 + out * 0.28) / 1e6


if __name__ == "__main__":
    main()
