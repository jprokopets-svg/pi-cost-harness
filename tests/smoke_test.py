#!/usr/bin/env python3
"""Smoke test: install pi-cost-harness into a testbed repo, run one task
via the Pi adapter, and confirm the AgentResult contract holds AND the
agent actually did work (tokens > 0, turns >= 1, bug fixed).

Prerequisites:
  - Pi CLI installed (`pi --version` works)
  - A provider API key set (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)

Usage:
    python3 tests/smoke_test.py [testbed_path]

If no testbed_path is given, creates a minimal throwaway repo in /tmp.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Import from the vendored adapter in this repo (no benchmark repo needed).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "adapter"))
from pi_adapter import PiAdapter


def _make_testbed(base: Path) -> Path:
    """Create a minimal Python repo with a deliberate bug and a test."""
    repo = base / "smoke_testbed"
    repo.mkdir(exist_ok=True)

    subprocess.run(["git", "init"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"],
                   cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Smoke"],
                   cwd=repo, capture_output=True)

    src = repo / "calculator.py"
    src.write_text(
        'def add(a, b):\n'
        '    """Add two numbers."""\n'
        '    return a - b  # BUG: should be a + b\n'
    )

    test = repo / "test_calculator.py"
    test.write_text(
        'from calculator import add\n'
        '\n'
        'def test_add():\n'
        '    assert add(2, 3) == 5\n'
    )

    pyproject = repo / "pyproject.toml"
    pyproject.write_text('[tool.pytest.ini_options]\n')

    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial"],
                   cwd=repo, capture_output=True)

    return repo


def _check_pi_installed() -> bool:
    try:
        result = subprocess.run(["pi", "--version"],
                                capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _test_actually_passes(testbed: Path) -> bool:
    """Run the testbed's test and return True if it passes."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-x", "-q", "test_calculator.py"],
        cwd=testbed, capture_output=True, text=True, timeout=30,
    )
    return result.returncode == 0


def _validate_result(result, testbed: Path) -> list[str]:
    """Validate AgentResult contract AND substantive work. Returns failures."""
    failures = []

    # ── Shape checks ──────────────────────────────────────────────────
    for field_name in ["success_exit", "input_tokens", "working_tokens",
                       "output_tokens", "tool_calls", "turns", "wall_time_s",
                       "cost_usd", "raw"]:
        if not hasattr(result, field_name):
            failures.append(f"Missing field: {field_name}")

    if not isinstance(result.success_exit, bool):
        failures.append(f"success_exit should be bool, got {type(result.success_exit)}")
    if not isinstance(result.raw, dict):
        failures.append(f"raw should be dict, got {type(result.raw)}")

    expected_total = result.input_tokens + result.working_tokens + result.output_tokens
    if result.total_tokens != expected_total:
        failures.append(
            f"total_tokens mismatch: {result.total_tokens} != "
            f"{result.input_tokens}+{result.working_tokens}+{result.output_tokens}"
        )

    # ── Substantive checks (the run actually did something) ───────────
    if result.turns < 1:
        failures.append(f"turns must be >= 1, got {result.turns}")
    if result.total_tokens <= 0:
        failures.append(f"total_tokens must be > 0, got {result.total_tokens}")
    if result.input_tokens <= 0:
        failures.append(f"input_tokens must be > 0, got {result.input_tokens}")
    if result.output_tokens <= 0:
        failures.append(f"output_tokens must be > 0, got {result.output_tokens}")
    if result.wall_time_s <= 0:
        failures.append(f"wall_time_s must be > 0, got {result.wall_time_s}")

    # ── Error message check ───────────────────────────────────────────
    error_messages = result.raw.get("error_messages", [])
    if error_messages:
        failures.append(f"Pi returned error(s): {error_messages[0][:120]}")

    # ── Functional check: did the agent actually fix the bug? ─────────
    if not _test_actually_passes(testbed):
        failures.append(
            "Functional check FAILED: test_calculator.py still fails after "
            "the agent ran — the bug was not fixed."
        )

    return failures


def main():
    print("=== pi-cost-harness smoke test ===\n")

    if not _check_pi_installed():
        print("SKIP: Pi CLI not installed. Install from https://pi.dev")
        sys.exit(0)

    # Set up testbed.
    if len(sys.argv) > 1:
        testbed = Path(sys.argv[1])
    else:
        tmpdir = tempfile.mkdtemp(prefix="pi_smoke_")
        testbed = _make_testbed(Path(tmpdir))
        print(f"Created testbed at: {testbed}")

    # Confirm the test fails BEFORE the agent runs.
    if _test_actually_passes(testbed):
        print("ERROR: test_calculator.py already passes before agent run — "
              "testbed is broken.")
        sys.exit(1)
    print("Pre-check: test_calculator.py fails as expected (bug present).\n")

    # Run one task via the adapter.
    print(f"Running Pi on: {testbed}")
    prompt = (
        "Fix the bug in calculator.py so that test_calculator.py passes. "
        "Run `python -m pytest -x -q test_calculator.py` to confirm."
    )

    adapter = PiAdapter()
    result = adapter.run(
        prompt=prompt,
        workdir=testbed,
        model="",  # Use Pi's default model.
        timeout_s=120,
    )

    # Report.
    print(f"\nResult:")
    print(f"  success_exit:     {result.success_exit}")
    print(f"  input_tokens:     {result.input_tokens}")
    print(f"  working_tokens:   {result.working_tokens}")
    print(f"  output_tokens:    {result.output_tokens}")
    print(f"  cache_read:       {result.cache_read_tokens}")
    print(f"  cache_create:     {result.cache_creation_tokens}")
    print(f"  total_tokens:     {result.total_tokens}")
    print(f"  tool_calls:       {result.tool_calls}")
    print(f"  turns:            {result.turns}")
    print(f"  wall_time_s:      {result.wall_time_s:.1f}")
    print(f"  cost_usd:         {result.cost_usd}")
    print(f"  raw events:       {len(result.raw.get('events', []))}")

    # Print stderr/errors if present.
    stderr = result.raw.get("stderr", "")
    if stderr:
        print(f"\n  stderr (first 10 lines):")
        for line in stderr.strip().splitlines()[:10]:
            print(f"    {line}")

    error_messages = result.raw.get("error_messages", [])
    if error_messages:
        print(f"\n  error_messages:")
        for msg in error_messages:
            print(f"    {msg[:200]}")

    failures = _validate_result(result, testbed)
    if failures:
        print(f"\nFAILED — {len(failures)} violation(s):")
        for f in failures:
            print(f"  ✗ {f}")
        sys.exit(1)
    else:
        print(f"\nPASS — AgentResult contract holds, bug was fixed.")
        sys.exit(0)


if __name__ == "__main__":
    main()
