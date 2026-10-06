"""The orchestrator: one task, start to finish.

Responsibilities, in order:

1. Walk the status machine (``queued`` → ``starting`` → ``running`` → terminal).
2. Pick an execution engine and run it, emitting typed events as it goes.
3. Synthesise the report.
4. Settle exactly once.

Deliberately *not* responsible for: persistence details, the state machine rules,
or the worker pool. It receives a :class:`~app.core.task_manager.TaskContext` and
expresses intent through it, so the manager owns lifecycle correctness and the
orchestrator owns the work.

Cancellation is cooperative and never swallowed: :class:`TaskCancelled` is allowed
to propagate so :meth:`TaskManager._run_one` can settle the task as ``cancelled``
with the reason the user gave.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from ..adapters.base import AdapterError
from ..adapters.browser_adapter import BrowserAdapter, BrowserRunResult
from ..adapters.extension_adapter import ExtensionAdapter
from ..adapters.ollama_adapter import OllamaAdapter
from ..adapters.openclaw_adapter import OpenClawAdapter
from ..browser.browser_events import BrowserEventEmitter
from ..browser.frame_manager import FrameManager
from ..config import Settings
from ..schemas.event import EventType
from ..schemas.report import FindingDto, TaskReportDto
from ..schemas.task import TaskStatus
from ..services.report_service import ReportService

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .task_manager import TaskContext

logger = logging.getLogger("agentwebeinh.orchestrator")


class Orchestrator:
    """Executes exactly one task."""

    def __init__(
        self,
        *,
        settings: Settings,
        browser: BrowserAdapter,
        ollama: OllamaAdapter,
        openclaw: OpenClawAdapter,
        frames: FrameManager,
        reports: ReportService,
        extension: ExtensionAdapter | None = None,
    ) -> None:
        self._settings = settings
        self._browser = browser
        self._ollama = ollama
        self._openclaw = openclaw
        self._frames = frames
        self._reports = reports
        self._extension = extension

    async def __call__(self, context: TaskContext) -> None:
        """Run the task. Raises only to signal a failure the manager should settle."""
        await self._begin(context)
        context.check_cancelled()

        findings_result, engine_note = await self._execute(context)

        context.check_cancelled()
        await context.update(current_activity="Writing the report", progress=0.9)
        await context.emit(
            EventType.LOG,
            "Composing the report from the collected evidence.",
        )

        report = await self._reports.build(
            prompt=context.prompt,
            findings=findings_result.findings,
            actions=findings_result.actions,
            pages=findings_result.pages_visited,
            engine_note=engine_note,
            run_summary=findings_result.summary or None,
        )

        # Clear the live view before the terminal event so the frontend does not
        # show a stale browser frame next to a finished task.
        await self._frames.clear(context.task_id)
        await context.update(current_url=None, current_title=None)

        await context.complete(
            _as_payload(report),
            message=f"Task completed with {len(report.findings)} finding(s).",
        )

    # ------------------------------------------------------------------ phases --

    async def _begin(self, context: TaskContext) -> None:
        """``queued`` → ``starting`` → ``running``, with events at each step."""
        await context.transition(TaskStatus.STARTING)
        await context.update(
            current_activity="Preparing the run",
            progress=0.05,
            engine=self._settings.browser_engine,
        )
        await context.emit(
            EventType.AGENT_STARTED,
            "Starting the task.",
            detail=context.prompt[:400],
        )

        await context.transition(TaskStatus.RUNNING)
        await context.emit(
            EventType.LOG,
            "Task is running.",
            data={"status": TaskStatus.RUNNING.value},
        )

    async def _execute(self, context: TaskContext) -> tuple[BrowserRunResult, str | None]:
        """Run the engine, degrading gracefully when an optional one is absent."""
        emitter = BrowserEventEmitter(context, self._frames)
        result = BrowserRunResult()

        if self._settings.browser_extension_enabled and self._settings.browser_extension_agent:
            return await self._run_extension_engine(context, emitter, result)

        browser_health = self._browser.health()
        if not browser_health.ok and browser_health.state != "disabled":
            raise AdapterError(
                browser_health.detail,
                code="browser_unavailable",
                retryable=True,
            )

        if self._settings.openclaw_orchestrates:
            contributed, note = await self._consult_openclaw(context, emitter, result)
            if contributed:
                return result, note

        await emitter.log("Starting the browser agent.")
        context.check_cancelled()
        outcome = await self._browser.run(
            context.task_id,
            context.prompt,
            emitter=emitter,
            token=context.cancel,
        )

        # The browser run is the primary engine; if OpenClaw is enabled, let it add
        # research as a supplement rather than replacing what was already verified.
        # Accumulate into ``outcome`` — a throwaway result here would be discarded
        # by the ``return`` below and the research would silently never be reported.
        note: str | None = None
        if self._settings.openclaw_enabled and not outcome.findings:
            _, note = await self._consult_openclaw(context, emitter, outcome)
        return outcome, note

    async def _run_extension_engine(
        self,
        context: TaskContext,
        emitter: BrowserEventEmitter,
        result: BrowserRunResult,
    ) -> tuple[BrowserRunResult, str | None]:
        """Drive the paired Chrome extension as the primary browser engine.

        The engine waits for a paired (and free) extension up to the configured
        budget; a task submitted while no browser is paired therefore fails with
        ``browser_extension_unavailable`` rather than hanging in ``running``.
        """
        if self._extension is None:
            raise AdapterError(
                "The extension engine is enabled but was not wired at startup.",
                code="browser_extension_unavailable",
                retryable=True,
            )

        await context.emit(
            EventType.BROWSER_OPENED,
            "Waiting for the paired browser extension.",
            detail="Enter a pairing code in the AgentWebEinh extension popup.",
        )
        context.check_cancelled()
        outcome = await self._extension.run(
            context.task_id,
            context.prompt,
            emitter=emitter,
            token=context.cancel,
        )

        note: str | None = None
        if self._settings.openclaw_enabled and not outcome.findings:
            _, note = await self._consult_openclaw(context, emitter, outcome)
        return outcome, note

    async def _consult_openclaw(
        self,
        context: TaskContext,
        emitter: BrowserEventEmitter,
        result: BrowserRunResult,
    ) -> tuple[bool, str | None]:
        """Optionally hand the task to OpenClaw for a research pass.

        Returns ``(contributed, note)``. ``contributed`` is the only signal that
        the caller should stop and use this engine; ``note`` is an optional caveat
        for the report. They are separate because a *successful* pass that produced
        findings needs no caveat, while the orchestrate branch must not fall
        through to the browser engine just because the caveat was absent.

        Findings are parsed straight into ``result`` so the reply reaches the report
        instead of being truncated into an action detail. Every failure is a soft
        downgrade: an unavailable gateway must not fail the task.
        """
        if not self._settings.openclaw_enabled:
            return False, None

        await emitter.log("Asking OpenClaw for a research pass.")
        await context.emit(
            EventType.LOG,
            "Calling OpenClaw",
            data={"tool": "openclaw", "label": "openclaw agent"},
        )
        context.check_cancelled()
        try:
            reply = await self._openclaw.run_agent(context.task_id, self._openclaw_prompt(context))
        except AdapterError as exc:
            await context.emit(
                EventType.LOG,
                "OpenClaw was unavailable.",
                detail=str(exc),
                data={"tool": "openclaw", "ok": False},
            )
            logger.info("openclaw_pass_skipped task_id=%s error=%s", context.task_id, type(exc).__name__)
            return False, None

        await context.emit(
            EventType.LOG,
            "OpenClaw finished its research pass.",
            detail=reply[:400],
            data={"tool": "openclaw", "ok": True},
        )

        clean = reply.strip()
        if not clean:
            return False, None

        result.record_action("OpenClaw research pass", status="performed", detail=clean[:400])
        structured = _ingest_openclaw_reply(result, clean)
        if structured:
            return True, None
        return True, (
            "The OpenClaw research pass replied in a form that could not be split "
            "into labelled findings, so its text is kept as a single finding."
        )

    def _openclaw_prompt(self, context: TaskContext) -> str:
        return (
            "Research the following task and report concrete, sourced findings. "
            "Do not attempt to send messages to any channel or contact anyone.\n\n"
            f"TASK:\n{context.prompt}\n\n"
            "Reply with the findings themselves, each on its own line as "
            "'Label: value (source url)'."
        )


#: Cap on findings parsed out of a single OpenClaw reply.
_MAX_OPENCLAW_FINDINGS = 40
#: Trailing ``(https://...)`` on a finding line becomes its source. The inner
#: group is optional because agents habitually label the link
#: (``(source url: https://...)``, ``[via https://...]``); leaving the label
#: inside the finding value would print "Example Domain (source url: https://…)"
#: in the report instead of the fact the task actually asked for.
_SOURCE_SUFFIX = re.compile(
    r"\s*[\(\[]\s*(?:[A-Za-z][A-Za-z ]{0,20}(?::|\s))?\s*(https?://[^\)\]\s]+)\s*[\)\]]\s*$"
)


def _ingest_openclaw_reply(result: BrowserRunResult, reply: str) -> bool:
    """Turn an OpenClaw reply into report findings and sources.

    The prompt asks for ``Label: value (source url)`` per line, which is easy to
    parse and cheap to verify. A reply with no recognisable line shape at all is
    kept as a **single** finding: splitting a paragraph into per-line findings
    would present fragments as if they were distinct facts, while dropping them
    would discard the only evidence the run produced.

    Returns ``True`` when at least one line was structurally recognised.
    """
    parsed: list[FindingDto] = []
    pages: list[tuple[str, None]] = []
    recognised = False

    for line in reply.splitlines():
        text = line.strip().lstrip("-*• ").strip()
        if not text:
            continue

        source_url: str | None = None
        match = _SOURCE_SUFFIX.search(text)
        if match:
            source_url = match.group(1)
            text = text[: match.start()].strip()

        label, separator, value = text.partition(":")
        if separator and label.strip() and value.strip():
            recognised = True
            label, value = label.strip(), value.strip()
        elif source_url:
            recognised = True
            label, value = "OpenClaw finding", text
        else:
            label, value = "OpenClaw finding", text

        if not value:
            continue

        parsed.append(
            FindingDto(label=label[:80], value=value[:2_000], source_url=source_url)
        )
        if source_url:
            pages.append((source_url, None))
        if len(parsed) >= _MAX_OPENCLAW_FINDINGS:
            break

    if not parsed:
        return False

    if not recognised:
        result.add_finding("OpenClaw reply", reply)
        return False

    result.findings.extend(parsed)
    for url, title in pages:
        result.note_page(url, title)
    return True


def _as_payload(report: TaskReportDto) -> dict[str, object]:
    """Serialise the report for storage.

    ``by_alias`` keeps the camelCase keys the frontend's normalizer accepts for
    nested report fields.
    """
    return report.model_dump(mode="json", by_alias=True)


__all__ = ["Orchestrator"]
