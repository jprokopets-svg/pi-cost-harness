# pi-cost-harness

Benchmark-winning treatments ported to [Pi](https://pi.dev) extension hooks.
Installable as a Pi package; each extension toggleable for ablation runs.

## Install

```bash
pi install git:github.com/jprokopets-svg/pi-cost-harness
```

Or project-local:

```bash
pi install git:github.com/jprokopets-svg/pi-cost-harness -l
```

## Extensions

| Extension | What it does | Treatment flag |
|-----------|-------------|----------------|
| `briefing` | Session-start repo map + test map + git log injected as context. Cached to `.pi-harness/briefing.md`, regenerated when HEAD moves. | `briefing` |
| `verify-gate` | Detects test command (pytest/npm/make/cargo/go). Blocks completion if tests weren't run or failed. | `verify_gate` |
| `output-hygiene` | Strips ANSI from bash output, caps at 100 lines (50 head + 50 tail), dedupes repeated file reads. | `output_hygiene` |
| `terse-edits` | System prompt: smallest working change, minimal diff, no drive-by cleanup. | `terse_edits` |
| `plan-first` | For multi-file tasks, blocks edits until plan.md is written. | `plan_first` |

## Configuration

Create `pi-harness.config.json` in the project root (or the package ships a default):

```json
{
  "briefing": true,
  "verify_gate": true,
  "output_hygiene": true,
  "terse_edits": true,
  "plan_first": true
}
```

Set any flag to `false` to disable that extension. Mirrors the benchmark's
treatment flags for ablation.

## Benchmark adapter

`adapter/pi_adapter.py` implements the `AgentAdapter` interface from
[llm-cost-harness](https://github.com/jprokopets-svg/llm-cost-harness).
Uses `pi --mode json` to capture per-turn usage, tool calls, and wall time.

```python
from adapter.pi_adapter import PiAdapter

adapter = PiAdapter(max_turns=30)
result = adapter.run("Fix the failing test", workdir=Path("./repo"), model="sonnet")
```

## Requirements

- Pi v0.70+ (extension API with `tool_call`/`tool_result` hooks)
- Python 3.11+ (for briefing.py; falls back to git-log-only if unavailable)
- Node.js 18+ (Pi runtime)
