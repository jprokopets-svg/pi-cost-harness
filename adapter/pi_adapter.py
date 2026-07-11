"""Pi agent adapter for the benchmark harness.

Uses `pi --mode json` (JSONL output) to capture per-turn usage, tool calls,
and wall time. Returns the same AgentResult contract as claude_code.py and
codex.py so Pi is directly comparable in cross-agent benchmark runs.

Pi's JSON mode emits events as newline-delimited JSON. Key event types:
  - session          : session header (version, id)
  - turn_end         : per-turn message + tool results
  - message_end      : assistant message with content blocks
  - tool_execution_*  : tool call lifecycle
  - agent_end        : final messages array

Usage fields come from message_end events (message.usage) and/or a
dedicated usage event if the provider surfaces one.
"""
import json
import os
import subprocess
import time
from pathlib import Path

# Prefer the vendored copy so this works standalone (no benchmark repo
# on PYTHONPATH). Falls back to the canonical harness import if available.
try:
    from .base import AgentAdapter, AgentResult
except ImportError:
    from base import AgentAdapter, AgentResult


class PiAdapter(AgentAdapter):
    """Adapter for the Pi coding agent (earendil-works/pi)."""

    name = "pi"

    def __init__(
        self,
        env: dict | None = None,
        extensions_enabled: dict | None = None,
        max_turns: int | None = None,
    ):
        """
        Args:
            env: extra environment variables to pass to pi.
            extensions_enabled: which pi-cost-harness extensions to enable.
                Maps extension name to bool. If None, all enabled.
            max_turns: optional turn cap (pi flag --max-turns).
        """
        self._env = env or {}
        self._extensions = extensions_enabled or {}
        self._max_turns = max_turns

    def _build_env(self) -> dict:
        """Build the subprocess environment for pi."""
        env = os.environ.copy()
        env.update(self._env)
        # Disable interactive features that interfere with headless mode.
        env["PI_NON_INTERACTIVE"] = "1"
        return env

    def _build_cmd(self, prompt: str, model: str) -> list[str]:
        """Build the pi command line."""
        cmd = ["pi", "--mode", "json"]
        if model:
            cmd.extend(["--model", model])
        if self._max_turns:
            cmd.extend(["--max-turns", str(self._max_turns)])
        cmd.append(prompt)
        return cmd

    def run(
        self,
        prompt: str,
        workdir: Path,
        model: str = "",
        timeout_s: int = 1800,
        env_override: dict | None = None,
    ) -> AgentResult:
        cmd = self._build_cmd(prompt, model)
        env = self._build_env()
        if env_override:
            env.update(env_override)

        t0 = time.time()
        try:
            proc = subprocess.run(
                cmd,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env=env,
            )
        except subprocess.TimeoutExpired as e:
            wall = time.time() - t0
            return AgentResult(
                success_exit=False,
                wall_time_s=wall,
                raw={"timeout": True, "stdout": e.stdout or "", "stderr": e.stderr or ""},
            )
        wall = time.time() - t0

        return _parse_json_output(proc.stdout, proc.returncode, wall)


def _parse_json_output(stdout: str, returncode: int, wall: float) -> AgentResult:
    """Parse Pi's --mode json JSONL output into an AgentResult.

    Pi emits one JSON object per line. We accumulate usage from message_end
    events and count tool executions and turns from the event stream.
    """
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_creation_tokens = 0
    tool_calls = 0
    turns = 0
    first_turn_input = 0
    turn_index = 0
    raw_events = []

    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        raw_events.append(event)
        event_type = event.get("type", "")

        # Count turns.
        if event_type == "turn_end":
            turns += 1

        # Count tool executions.
        if event_type == "tool_execution_end":
            tool_calls += 1

        # Extract usage from message_end events.
        if event_type == "message_end":
            turn_index += 1
            message = event.get("message", {})
            usage = message.get("usage", {})

            turn_input = usage.get("input_tokens", 0)
            turn_output = usage.get("output_tokens", 0)
            turn_cache_read = usage.get("cache_read_input_tokens", 0)
            turn_cache_create = usage.get("cache_creation_input_tokens", 0)

            if turn_index == 1:
                first_turn_input = turn_input

            input_tokens += turn_input
            output_tokens += turn_output
            cache_read_tokens += turn_cache_read
            cache_creation_tokens += turn_cache_create

    # Decompose: first turn's input is the prompt size (input_tokens field);
    # subsequent input is working_tokens (intermediate context traffic).
    working_tokens = max(0, input_tokens - first_turn_input)

    return AgentResult(
        success_exit=(returncode == 0),
        input_tokens=first_turn_input,
        working_tokens=working_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_creation_tokens=cache_creation_tokens,
        tool_calls=tool_calls,
        turns=turns,
        wall_time_s=wall,
        cost_usd=0.0,  # Filled by metering.py from pricing table.
        raw={"events": raw_events},
    )
