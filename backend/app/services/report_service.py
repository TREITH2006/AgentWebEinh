"""Report synthesis.

The browser run collects findings and pages; this turns them into the
:class:`~app.schemas.report.TaskReportDto` the frontend renders. Two invariants
are enforced here rather than trusted:

* **Never empty.** The frontend treats a wholly empty report as *absent* and
  shows "no report returned". So even a run that collected nothing gets a summary
  explaining what happened.
* **Never fabricate.** The synthesis prompt is explicit that findings must come
  from the supplied evidence, and a model reply that cannot be parsed degrades to
  the raw findings instead of inventing content.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

from ..adapters.base import AdapterError, redact
from ..adapters.ollama_adapter import OllamaAdapter
from ..config import Settings
from ..schemas.report import FindingDto, SourceDto, TaskActionDto, TaskReportDto
from ..utils.time import now_iso

logger = logging.getLogger("agentwebeinh.report")

#: Findings included in the prompt. Enough to summarise, small enough to fit.
_MAX_PROMPT_FINDINGS = 40

SYNTHESIS_SYSTEM_PROMPT = """You write the final report for a completed web-research task.

You are given the user's task, the steps that were performed, the pages that were
read, and the findings that were collected.

Rules:
- Use ONLY the supplied evidence. Never add a fact that is not in the evidence.
- If the evidence is thin, say so plainly in the summary rather than padding it.
- Every finding you output needs a non-empty "value".
- Write the summary as two or three concrete sentences about what was found.

Reply with one JSON object and nothing else:
{
  "summary": "...",
  "findings": [{"label": "...", "value": "...", "sourceUrl": "..."}],
  "limitations": ["..."]
}"""


class ReportService:
    """Builds the final report for a run."""

    def __init__(self, settings: Settings, ollama: OllamaAdapter) -> None:
        self._settings = settings
        self._ollama = ollama

    async def build(
        self,
        *,
        prompt: str,
        findings: list[FindingDto],
        actions: list[TaskActionDto],
        pages: list[dict[str, str | None]],
        engine_note: str | None = None,
        run_summary: str | None = None,
    ) -> TaskReportDto:
        """Synthesise a report, falling back to raw evidence if the model fails."""
        sources = _sources(pages)

        summary: str
        limitations: list[str] = []
        refined: list[FindingDto] = list(findings)

        try:
            synthesis = await self._ollama.chat_json(
                SYNTHESIS_SYSTEM_PROMPT,
                _evidence_prompt(prompt, findings, actions, pages, engine_note, run_summary),
                num_predict=800,
            )
            summary = str(synthesis.get("summary") or "").strip()
            refined = _merge_findings(findings, synthesis.get("findings"))
            raw_limitations = synthesis.get("limitations")
            if isinstance(raw_limitations, list):
                limitations = [
                    str(item).strip()[:400] for item in raw_limitations if str(item).strip()
                ]
        except AdapterError as exc:
            # A failed summary must not lose the evidence that was already gathered.
            logger.warning("report_synthesis_failed error=%s", type(exc).__name__)
            summary = _fallback_summary(prompt, findings, run_summary)
            limitations.append(
                "The narrative summary could not be generated, so this report lists "
                "the raw collected findings."
            )

        if not summary:
            summary = _fallback_summary(prompt, refined, run_summary)
        if not refined and not limitations:
            limitations.append("No findings were collected for this task.")
        if engine_note:
            limitations.append(engine_note)

        report = TaskReportDto(
            summary=summary,
            actions=actions,
            findings=refined,
            sources=sources,
            limitations=limitations[:10],
        )
        if report.is_empty():
            # Belt and braces: the frontend must never receive an empty report.
            report.summary = summary or "The task finished without producing a report."
        return report


def _sources(pages: list[dict[str, str | None]]) -> list[SourceDto]:
    """De-duplicate pages into report sources, preserving visit order."""
    seen: set[str] = set()
    sources: list[SourceDto] = []
    for page in pages:
        url = (page.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        title = (page.get("title") or "").strip() or None
        sources.append(
            SourceDto(url=url, title=title, domain=_domain(url), accessed_at=now_iso())
        )
        if len(sources) >= 25:
            break
    return sources


def _domain(url: str) -> str | None:
    try:
        return urlparse(url).netloc or None
    except ValueError:
        return None


def _evidence_prompt(
    prompt: str,
    findings: list[FindingDto],
    actions: list[TaskActionDto],
    pages: list[dict[str, str | None]],
    engine_note: str | None,
    run_summary: str | None = None,
) -> str:
    lines = [f"TASK:\n{prompt}"]

    lines.append(
        "\nSTEPS PERFORMED:\n"
        + "\n".join(
            f"{index}. {action.label or action.status or 'step'}"
            + (f" -> {action.url}" if action.url else "")
            + (f" [{action.status}]" if action.status else "")
            for index, action in enumerate(actions[:60], start=1)
        )
        if actions
        else "\nSTEPS PERFORMED:\n(none recorded)"
    )

    lines.append(
        "\nPAGES READ:\n"
        + "\n".join(f"- {page.get('title') or '(untitled)'}: {page.get('url')}" for page in pages[:25])
        if pages
        else "\nPAGES READ:\n(none)"
    )

    trimmed = findings[:_MAX_PROMPT_FINDINGS]
    lines.append(
        "\nFINDINGS:\n"
        + "\n".join(f"- {item.label or 'finding'}: {item.value}" for item in trimmed)
        if trimmed
        else "\nFINDINGS:\n(none collected)"
    )
    if len(findings) > _MAX_PROMPT_FINDINGS:
        lines.append(f"\n({len(findings) - _MAX_PROMPT_FINDINGS} further findings omitted.)")

    if engine_note:
        lines.append(f"\nRUN NOTE:\n{engine_note}")

    if run_summary:
        lines.append(f"\nRUN CONCLUSION:\n{run_summary}")

    return redact("\n".join(lines), limit=12_000)


def _merge_findings(
    original: list[FindingDto], model_output: Any
) -> list[FindingDto]:
    """Prefer the model's phrasing, but only for facts already collected.

    A model that invents a finding cannot add one here: anything without a match
    against the original evidence is dropped.
    """
    if not isinstance(model_output, list) or not original:
        return original

    merged: list[FindingDto] = []
    used: set[int] = set()
    for candidate in model_output:
        if not isinstance(candidate, dict):
            continue
        label = str(candidate.get("label") or "").strip().lower()
        value = str(candidate.get("value") or "").strip()
        if not value:
            continue
        match = next(
            (
                index
                for index, item in enumerate(original)
                if index not in used
                and (
                    (item.label or "").strip().lower() == label
                    or item.value.strip().lower() == value.lower()
                )
            ),
            None,
        )
        if match is None:
            # Not in the evidence: refuse it.
            continue
        used.add(match)
        source = original[match]
        merged.append(
            FindingDto(
                label=label[:80] or source.label,
                value=value[:2_000],
                note=source.note,
                source_url=source.source_url,
            )
        )

    # Anything the model omitted stays in.
    merged.extend(item for index, item in enumerate(original) if index not in used)
    return merged


def _fallback_summary(
    prompt: str, findings: list[FindingDto], run_summary: str | None = None
) -> str:
    if not findings:
        # The agent's own conclusion is real evidence about the run, so it is a
        # better answer than "nothing was collected".
        if run_summary:
            return run_summary.strip()[:2_000]
        return f"No findings were collected while working on: {prompt.strip()[:200]}"
    labels = ", ".join((item.label or "finding") for item in findings[:5])
    return f"Collected {len(findings)} finding(s) for: {prompt.strip()[:200]} ({labels})."


__all__ = ["ReportService"]
