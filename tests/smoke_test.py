#!/usr/bin/env python3
"""Smoke test: install pi-cost-harness into a testbed repo, run one task
via the Pi adapter, and confirm the AgentResult contract holds.

Prerequisites:
  - Pi CLI installed (`pi --version` works)
  - pi-cost-harness installed (`pi install git:...` or `pi install . -l`)

Usage:
    python3 tests/smoke_test.py [testbed_path]

If no testbed_path is given, creates a minimal throwaway repo in /tmp.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Import from the vendored adapter in this repo (no benchmark repo needed).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "adapter"))
from pi_adapter import PiAdapter


def _make_testbed(base: Path) -> Path:
    """Create a minimal Python repo for the smoke test."""
    repo = base / "smoke_testbed"
    repo.mkdir(exist_ok=True)

    # Initialize git repo.
    subprocess.run(["git", "init"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Smoke"], cwd=repo, capture_output=True)

    # Write a simple Python file with a deliberate bug.
    src = repo / "calculator.py"
    src.write_text(
        'def add(a, b):\n'
        '    """Add two numbers."""\n'
        '    return a - b  # BUG: should be a + b\n'
    )

    # Write a test file.
    test = repo / "test_calculator.py"
    test.write_text(
        'from calculator import add\n'
        '\n'
        'def test_add():\n'
        '    assert add(2, 3) == 5\n'
    )

    # Write a pyproject.toml so test detection works.
    pyproject = repo / "pyproject.toml"
    pyproject.write_text('[tool.pytest.ini_options]\n')

    # Commit so git log works.
    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True)

    return repo


def _check_pi_installed() -> bool:
    """Check if Pi CLI is available."""
    try:
        result = subprocess.run(["pi", "--version"], capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _validate_result(result) -> list[str]:
    """Validate the AgentResult contract. Returns a list of failures."""
    failures = []

    # Required fields must exist.
    for field in ["success_exit", "input_tokens", "working_tokens",
                  "output_tokens", "tool_calls", "turns", "wall_time_s",
                  "cost_usd", "raw"]:
        if not hasattr(result, field):
            failures.append(f"Missing field: {field}")

    # Type checks.
    if not isinstance(result.success_exit, bool):
        failures.append(f"success_exit should be bool, got {type(result.success_exit)}")
    if not isinstance(result.input_tokens, int):
        failures.append(f"input_tokens should be int, got {type(result.input_tokens)}")
    if not isinstance(result.output_tokens, int):
        failures.append(f"output_tokens should be int, got {type(result.output_tokens)}")
    if not isinstance(result.working_tokens, int):
        failures.append(f"working_tokens should be int, got {type(result.working_tokens)}")
    if not isinstance(result.tool_calls, int):
        failures.append(f"tool_calls should be int, got {type(result.tool_calls)}")
    if not isinstance(result.turns, int):
        failures.append(f"turns should be int, got {type(result.turns)}")
    if not isinstance(result.wall_time_s, float):
        failures.append(f"wall_time_s should be float, got {type(result.wall_time_s)}")
    if not isinstance(result.raw, dict):
        failures.append(f"raw should be dict, got {type(result.raw)}")

    # Semantic checks.
    if result.wall_time_s <= 0:
        failures.append(f"wall_time_s should be positive, got {result.wall_time_s}")
    if result.input_tokens < 0:
        failures.append(f"input_tokens should be non-negative, got {result.input_tokens}")
    if result.working_tokens < 0:
        failures.append(f"working_tokens should be non-negative, got {result.working_tokens}")

    # total_tokens property.
    expected_total = result.input_tokens + result.working_tokens + result.output_tokens
    if result.total_tokens != expected_total:
        failures.append(
            f"total_tokens mismatch: {result.total_tokens} != "
            f"{result.input_tokens} + {result.working_tokens} + {result.output_tokens}"
        )

    return failures


def main():
    print("=== pi-cost-harness smoke test ===\n")

    # Check Pi is installed.
    if not _check_pi_installed():
        print("SKIP: Pi CLI not installed. Install from https://pi.dev")
        print("      The adapter unit tests (in llm-cost-harness) pass without Pi.")
        sys.exit(0)

    # Set up testbed.
    if len(sys.argv) > 1:
        testbed = Path(sys.argv[1])
    else:
        tmpdir = tempfile.mkdtemp(prefix="pi_smoke_")
        testbed = _make_testbed(Path(tmpdir))
        print(f"Created testbed at: {testbed}")

    # Run one task via the adapter.
    print(f"\nRunning Pi on: {testbed}")
    prompt = (
        "Fix the bug in calculator.py so that test_calculator.py passes. "
        "Run the tests to confirm."
    )

    adapter = PiAdapter(max_turns=10)
    result = adapter.run(
        prompt=prompt,
        workdir=testbed,
        model="",  # Use Pi's default model.
        timeout_s=120,
    )

    # Validate result contract.
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

    failures = _validate_result(result)
    if failures:
        print(f"\nFAILED — contract violations:")
        for f in failures:
            print(f"  ✗ {f}")
        sys.exit(1)
    else:
        print(f"\nPASS — AgentResult contract holds.")
        sys.exit(0)


if __name__ == "__main__":
    main()
