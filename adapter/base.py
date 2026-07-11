"""Vendored minimal AgentResult and AgentAdapter.

This is a self-contained copy of the contract types from llm-cost-harness
(harness/adapters/base.py) so pi-cost-harness can run standalone without
the benchmark repo on PYTHONPATH. The canonical version lives in
llm-cost-harness; keep this in sync if the contract changes.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class AgentResult:
    """Normalized per-run metrics every adapter must return."""
    success_exit: bool
    input_tokens: int = 0
    working_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    tool_calls: int = 0
    turns: int = 0
    wall_time_s: float = 0.0
    cost_usd: float = 0.0
    files_changed: int = 0
    diff_lines: int = 0
    verify_attempts: int = 0
    raw: dict = field(default_factory=dict)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.working_tokens + self.output_tokens

    @property
    def tokens_per_second(self) -> float:
        if self.wall_time_s <= 0:
            return 0.0
        return self.total_tokens / self.wall_time_s


class AgentAdapter(ABC):
    name: str = "base"

    @abstractmethod
    def run(self, prompt: str, workdir: Path, model: str, timeout_s: int,
            env_override: dict | None = None) -> AgentResult:
        ...

    def resume(self, session_id: str, follow_up: str, workdir: Path,
               model: str, timeout_s: int) -> AgentResult:
        return self.run(follow_up, workdir, model, timeout_s)
