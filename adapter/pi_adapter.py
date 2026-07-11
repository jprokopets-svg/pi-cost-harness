"""Pi agent adapter for the benchmark harness.

Uses `pi -p --mode json` (non-interactive JSONL output) to capture per-turn
usage, tool calls, and wall time. Returns the same AgentResult contract as
claude_code.py and codex.py so Pi is directly comparable in cross-agent
benchmark runs.

Pi's JSON mode emits events as newline-delimited JSON. Key event types:
  - session            : session header (version, id)
  - turn_end           : per-turn message + tool results
  - message_end        : assistant message with content blocks + usage
  - tool_execution_end : tool call completed
  - agent_end          : final messages array

Pi's usage fields use camelCase (input, output, cacheRead, cacheWrite,
totalTokens), NOT the snake_case names used by the Anthropic API.
"""
import json
import os
import subprocess
import sys
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
    ):
        """
        Args:
            env: extra environment variables for the pi subprocess.
            extensions_enabled: which pi-cost-harness extensions to enable.
                Maps extension name to bool. If None, all enabled.
        """
        self._env = env or {}
        self._extensions = extensions_enabled or {}

    def _build_env(self) -> dict:
        """Build the subprocess environment for pi."""
        env = os.environ.copy()
        env.update(self._env)
        return env

    def _build_cmd(self, prompt: str, model: str) -> list[str]:
        """Build the pi command line.

        -p (--print): non-interactive mode — process prompt and exit.
            Without this, pi launches an interactive TUI that hangs
            when stdout is piped.
        --mode json: emit every event as a JSONL line to stdout.
        --no-session: don't persist session state (ephemeral run).
        --model: required — without it Pi falls back to the saved
            subscription provider, which may be out of usage.
        """
        # Resolve model: explicit arg > PI_MODEL env var > default.
        resolved_model = model or os.environ.get(
            "PI_MODEL", "deepseek/deepseek-v4-flash"
        )
        cmd = ["pi", "-p", "--mode", "json", "--no-session",
               "--model", resolved_model, prompt]
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

        # Print the exact command for reproducibility.
        import shlex
        print(f"[pi-adapter] cmd: {shlex.join(cmd)}", file=sys.stderr)

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
        except subprocess.TimeoutExpired as exc:
            wall = time.time() - t0
            return AgentResult(
                success_exit=False,
                wall_time_s=wall,
                raw={"timeout": True, "stdout": exc.stdout or "",
                     "stderr": exc.stderr or ""},
            )
        wall = time.time() - t0

        result = _parse_json_output(proc.stdout, proc.returncode, wall)

        # Surface failures: if pi produced zero assistant events, something
        # went wrong (auth error, missing model, immediate exit). Attach
        # stderr and exit code to raw so callers can diagnose.
        if result.turns == 0 or result.total_tokens == 0:
            result.raw["stderr"] = proc.stderr
            result.raw["returncode"] = proc.returncode
            print(
                f"[pi-adapter] WARNING: zero-event run "
                f"(exit={proc.returncode}, turns={result.turns}, "
                f"tokens={result.total_tokens})",
                file=sys.stderr,
            )
            if proc.stderr:
                # Print first 20 lines of stderr so the failure is visible.
                stderr_lines = proc.stderr.strip().splitlines()
                for line in stderr_lines[:20]:
                    print(f"[pi-adapter]   {line}", file=sys.stderr)

        return result


def _parse_json_output(stdout: str, returncode: int, wall: float) -> AgentResult:
    """Parse Pi's --mode json JSONL output into an AgentResult.

    Pi emits one JSON object per line. Usage is accumulated from
    assistant-role message_end events. Tool calls are counted from
    tool_execution_end events. Turns are counted from turn_end events.

    Pi's usage schema (camelCase):
        message.usage.input       — input tokens this turn
        message.usage.output      — output tokens this turn
        message.usage.cacheRead   — cache-read tokens
        message.usage.cacheWrite  — cache-creation tokens
        message.usage.totalTokens — provider-reported total
    """
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_creation_tokens = 0
    tool_calls = 0
    turns = 0
    first_turn_input = 0
    assistant_turn_index = 0
    raw_events = []
    error_messages = []

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

        if event_type == "turn_end":
            turns += 1

        if event_type == "tool_execution_end":
            tool_calls += 1

        # Only count assistant messages — Pi also emits message_end for
        # user messages, which carry no usage.
        if event_type == "message_end":
            message = event.get("message", {})
            if message.get("role") != "assistant":
                continue

            # Capture error messages for diagnostics.
            error_msg = message.get("errorMessage")
            if error_msg:
                error_messages.append(error_msg)

            usage = message.get("usage", {})
            assistant_turn_index += 1

            # Pi uses camelCase field names, not snake_case.
            turn_input = usage.get("input", 0)
            turn_output = usage.get("output", 0)
            turn_cache_read = usage.get("cacheRead", 0)
            turn_cache_create = usage.get("cacheWrite", 0)

            if assistant_turn_index == 1:
                first_turn_input = turn_input

            input_tokens += turn_input
            output_tokens += turn_output
            cache_read_tokens += turn_cache_read
            cache_creation_tokens += turn_cache_create

    # First turn's input = prompt size; subsequent input = working tokens.
    working_tokens = max(0, input_tokens - first_turn_input)

    raw = {"events": raw_events}
    if error_messages:
        raw["error_messages"] = error_messages

    return AgentResult(
        success_exit=(returncode == 0 and not error_messages),
        input_tokens=first_turn_input,
        working_tokens=working_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_creation_tokens=cache_creation_tokens,
        tool_calls=tool_calls,
        turns=turns,
        wall_time_s=wall,
        cost_usd=0.0,  # Filled by metering.py from pricing table.
        raw=raw,
    )
