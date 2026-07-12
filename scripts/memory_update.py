#!/usr/bin/env python3
"""memory_update.py — ONE cheap-model call to extract memory deltas.

Called by repo-memory.ts on agent_end. Reads the session summary and
verify status, makes one DeepSeek-v4-flash call to extract:
  1. New facts about the repo (→ repo-model.md)
  2. If verify failed: one Reflexion-style lesson (→ lessons.md)

Writes usage to .pi-harness/memory_costs.jsonl so the adapter can fold
the memory-update cost into the run's total.

Usage:
    python3 scripts/memory_update.py /path/to/workspace
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

    # Read inputs.
    summary_path = mem_dir / "session_summary.tmp"
    status_path = mem_dir / "verify_status.tmp"

    if not summary_path.exists():
        return

    summary = summary_path.read_text()[:4000]
    verify_status = {}
    if status_path.exists():
        try:
            verify_status = json.loads(status_path.read_text())
        except json.JSONDecodeError:
            pass

    passed = verify_status.get("passed")

    # Read existing memory files.
    repo_model_path = mem_dir / "repo-model.md"
    lessons_path = mem_dir / "lessons.md"
    existing_model = repo_model_path.read_text() if repo_model_path.exists() else ""
    existing_lessons = lessons_path.read_text() if lessons_path.exists() else ""

    # Build the prompt for the memory update call.
    prompt = _build_prompt(summary, passed, existing_model, existing_lessons)

    # Make the API call.
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        return

    t0 = time.time()
    response = _call_deepseek(prompt, api_key)
    wall = time.time() - t0

    if not response:
        return

    content = response.get("content", "")
    usage = response.get("usage", {})

    # Parse the structured output.
    new_facts = _extract_section(content, "NEW_FACTS")
    new_lesson = _extract_section(content, "LESSON")

    # Append deltas (never rewrite existing entries).
    if new_facts.strip():
        _append_with_cap(repo_model_path, new_facts, max_chars=16000)

    if new_lesson.strip() and passed is False:
        _append_with_cap(lessons_path, new_lesson, max_chars=16000)

    # Write usage to memory_costs.jsonl for metering.
    cost_record = {
        "ts": time.time(),
        "wall_time_s": wall,
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cost_usd": _compute_cost(usage),
    }
    costs_path = mem_dir / "memory_costs.jsonl"
    with open(costs_path, "a") as f:
        f.write(json.dumps(cost_record) + "\n")

    # Clean up temp files.
    summary_path.unlink(missing_ok=True)
    status_path.unlink(missing_ok=True)


def _build_prompt(summary: str, passed: bool | None,
                  existing_model: str, existing_lessons: str) -> str:
    verify_context = ""
    if passed is False:
        verify_context = (
            "\nThe task's verification FAILED. Write one Reflexion-style lesson "
            "in the LESSON section: 'Assumed X; actually Y; next time Z.'\n"
        )
    elif passed is True:
        verify_context = "\nThe task's verification PASSED. No lesson needed.\n"

    return f"""You are a memory-update agent. Given the session transcript below, extract:
1. NEW_FACTS: 1-3 short bullet points of facts learned about the codebase
   that would help on future tasks in the same repo. Only add facts NOT
   already in the existing repo-model. If nothing new, write "(none)".
2. LESSON: If the task failed, one line: "Assumed X; actually Y; next time Z."
   If the task passed, write "(none)".

Output EXACTLY this format:
NEW_FACTS:
- fact 1
- fact 2

LESSON:
- assumed X; actually Y; next time Z

---
EXISTING REPO-MODEL (do not repeat these):
{existing_model[:1000]}

EXISTING LESSONS (do not repeat these):
{existing_lessons[:500]}
{verify_context}
SESSION TRANSCRIPT (last messages):
{summary}
"""


def _call_deepseek(prompt: str, api_key: str) -> dict | None:
    """Make one DeepSeek-v4-flash call. Returns {content, usage} or None."""
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
                "max_tokens": 300,
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
        print(f"[memory_update] API call failed: {e}", file=sys.stderr)
        return None


def _compute_cost(usage: dict) -> float:
    """DeepSeek-v4-flash pricing: $0.14/M input, $0.28/M output."""
    inp = usage.get("prompt_tokens", 0)
    out = usage.get("completion_tokens", 0)
    return (inp * 0.14 + out * 0.28) / 1e6


def _extract_section(content: str, section: str) -> str:
    """Extract content after SECTION: header until the next header or end."""
    marker = f"{section}:"
    lines = content.split("\n")
    capturing = False
    result = []
    for line in lines:
        if line.strip().upper().startswith(marker.upper()):
            capturing = True
            continue
        if capturing:
            # Stop at the next section marker.
            if line.strip().upper().startswith("NEW_FACTS:") or \
               line.strip().upper().startswith("LESSON:"):
                break
            result.append(line)
    return "\n".join(result).strip()


def _append_with_cap(path: Path, content: str, max_chars: int = 16000):
    """Append content to file, pruning oldest entries if over cap."""
    existing = path.read_text() if path.exists() else ""
    new_content = existing + "\n" + content if existing else content

    if len(new_content) > max_chars:
        # Oldest-first pruning: keep the last max_chars.
        new_content = new_content[-max_chars:]
        # Clean up: don't start mid-line.
        first_newline = new_content.find("\n")
        if first_newline > 0:
            new_content = new_content[first_newline + 1:]

    path.write_text(new_content)


if __name__ == "__main__":
    main()
