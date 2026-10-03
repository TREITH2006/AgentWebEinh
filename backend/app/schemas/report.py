"""Wire DTOs for the final task report.

One rule is load-bearing: every finding must carry a non-empty ``value``.
``normalizeFindings`` drops any finding whose value is missing, so a finding
without one is not rendered with a gap — it disappears entirely.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TaskActionDto(BaseModel):
    """One step the agent performed, in execution order."""

    model_config = ConfigDict(populate_by_name=True)

    index: int | None = None
    at: str | None = None
    label: str | None = None
    target: str | None = None
    url: str | None = None
    #: ``performed`` | ``skipped`` | ``failed``; anything else renders as performed.
    status: str | None = None
    detail: str | None = None


class FindingDto(BaseModel):
    """A single extracted result. ``value`` is required — see module docstring."""

    model_config = ConfigDict(populate_by_name=True)

    label: str | None = None
    value: str = Field(min_length=1)
    note: str | None = None
    source_url: str | None = Field(default=None, alias="sourceUrl")


class SourceDto(BaseModel):
    """A page the agent actually read."""

    model_config = ConfigDict(populate_by_name=True)

    url: str
    title: str | None = None
    domain: str | None = None
    accessed_at: str | None = Field(default=None, alias="accessedAt")


class TaskReportDto(BaseModel):
    """The report stored on a settled task.

    Sections may be empty, but at least one must carry content: the frontend
    treats a wholly empty report as *absent* and says "no report returned".
    """

    model_config = ConfigDict(populate_by_name=True)

    summary: str | None = None
    actions: list[TaskActionDto] = Field(default_factory=list)
    findings: list[FindingDto] = Field(default_factory=list)
    sources: list[SourceDto] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    #: Untouched payload, shown verbatim behind a disclosure in the UI.
    raw: Any | None = None

    def is_empty(self) -> bool:
        """Mirror of the frontend's emptiness test for a report."""
        return not (
            self.summary
            or self.actions
            or self.findings
            or self.sources
            or self.limitations
        )
