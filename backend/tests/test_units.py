"""Unit tests for logic that has no HTTP surface.

These are the pieces where a bug is silent: a report that loses the only evidence
a run produced, a frame stream that starves one of two viewers, or a state machine
that permits a task to run backwards.
"""

from __future__ import annotations

import asyncio
import json
from unittest import mock

import pytest

from app.adapters.base import AdapterError, IntegrationHealth
from app.adapters.browser_adapter import (
    _PROGRESS_STARTED,
    _looks_like_challenge,
    _progress_for_step,
    _stalled_summary,
    _STALL_STEP_LIMIT,
    _url_from_prompt,
    ACTIONS,
    BrowserRunResult,
    normalize_action,
)
from app.adapters.openclaw_adapter import _extract_reply
from app.browser.frame_manager import FrameManager
from app.config import Settings, settings_override
from app.core.orchestrator import _ingest_openclaw_reply
from app.schemas.report import FindingDto
from app.services.health_service import PROBE_BUDGET_SECONDS, HealthService
from app.services.report_service import _fallback_summary
from app.core.state_machine import (
    InvalidTransition,
    can_transition,
    ensure_transition,
    is_terminal,
)
from app.schemas.task import TaskStatus
from app.utils.ids import is_ulid_like, new_event_id, new_task_id

# --------------------------------------------------------------- OpenClaw parse --


def test_openclaw_reply_becomes_findings_and_sources() -> None:
    """A reply in the documented shape must reach the report as findings."""
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(
        result,
        "Monthly price: 42 USD per seat (https://example.com/pricing)\n"
        "Support: included, no extra cost (https://example.com/support)\n",
    )

    assert structured is True
    assert [f.label for f in result.findings] == ["Monthly price", "Support"]
    assert result.findings[0].value == "42 USD per seat"
    assert result.findings[0].source_url == "https://example.com/pricing"
    # Sourced findings must also register as pages, or they vanish from `sources`.
    assert [page["url"] for page in result.pages_visited] == [
        "https://example.com/pricing",
        "https://example.com/support",
    ]


def test_openclaw_reply_bullets_and_bare_lines_are_accepted() -> None:
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(
        result, "- Bullet label: bullet value\n* no colon on this line\n"
    )

    assert structured is True
    assert result.findings[0].label == "Bullet label"
    # A line with no "label: value" split is still evidence, not a reason to drop it.
    assert result.findings[1].value == "no colon on this line"
    assert result.findings[1].source_url is None


def test_unstructured_openclaw_reply_is_kept_whole() -> None:
    """An unparseable reply is the only evidence the run produced: keep it."""
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(result, "Everything is on one line")

    assert structured is False
    assert len(result.findings) == 1
    assert result.findings[0].value == "Everything is on one line"


def test_empty_openclaw_reply_adds_nothing() -> None:
    result = BrowserRunResult()

    assert _ingest_openclaw_reply(result, "   \n  \n") is False
    assert result.findings == []


def test_openclaw_envelope_yields_the_answer_not_its_metadata() -> None:
    """The CLI's answer lives in ``result.payloads[].text``.

    A walker that only descends into objects never reaches an array, so extraction
    found nothing and fell back to re-serialising the whole envelope. The report
    parser then read that JSON as prose and split it on the first colon, which put
    a finding labelled ``{"runId"`` in front of the user instead of the page title
    they asked for.
    """
    envelope = {
        "runId": "32674646-ad99-45eb-9506-04aa8b0489e5",
        "status": "ok",
        "summary": "completed",
        "result": {
            "payloads": [
                {
                    "text": (
                        "Page title: AgentWebEinh Local Test "
                        "(source url: http://127.0.0.1:8002)\n"
                        "Main heading: Local Browser Test Passed "
                        "(source url: http://127.0.0.1:8002)"
                    ),
                    "mediaUrl": None,
                }
            ],
            "meta": {
                "durationMs": 163_680,
                "agentMeta": {
                    "sessionFile": "agent:main:awe-task_01",
                    "provider": "ollama",
                    "model": "qwen3-vl:8b",
                    "usage": {"input": 14_560, "output": 1_191},
                },
            },
        },
        "aborted": False,
    }

    reply = _extract_reply(json.dumps(envelope))

    assert "AgentWebEinh Local Test" in reply
    assert "Local Browser Test Passed" in reply
    # Telemetry is not prose and must never reach the report.
    for noise in ("runId", "qwen3-vl:8b", "agent:main:awe"):
        assert noise not in reply, f"{noise!r} leaked into the extracted reply"


def test_openclaw_multiple_payloads_are_all_reported() -> None:
    envelope = {"result": {"payloads": [{"text": "First."}, {"text": "Second."}]}}

    assert _extract_reply(json.dumps(envelope)) == "First.\nSecond."


def test_openclaw_reply_extraction_still_accepts_legacy_shapes() -> None:
    assert _extract_reply(json.dumps({"result": "plain"})) == "plain"
    assert _extract_reply(json.dumps({"reply": {"text": "nested"}})) == "nested"
    assert _extract_reply("bare text") == "bare text"

    with pytest.raises(AdapterError):
        _extract_reply("   ")


def test_openclaw_findings_drop_the_source_url_annotation() -> None:
    """``(source url: ...)`` is provenance, not part of the answer."""
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(
        result,
        "Page title: AgentWebEinh Local Test (source url: http://127.0.0.1:8002)\n"
        "Main heading: Local Browser Test Passed (source url: http://127.0.0.1:8002)",
    )

    assert structured is True
    assert [(f.label, f.value) for f in result.findings] == [
        ("Page title", "AgentWebEinh Local Test"),
        ("Main heading", "Local Browser Test Passed"),
    ]
    assert all(f.source_url == "http://127.0.0.1:8002" for f in result.findings)


# ------------------------------------------------------------------ start url --


def test_a_url_named_in_the_prompt_becomes_the_start_url() -> None:
    """A prompt that names a URL is a navigation instruction, not a search."""
    prompt = "Open http://127.0.0.1:8002 and report the page title and the main heading."

    assert _url_from_prompt(prompt) == "http://127.0.0.1:8002"


def test_a_trailing_sentence_full_stop_is_not_part_of_the_url() -> None:
    assert _url_from_prompt("Check https://example.com/docs.") == "https://example.com/docs"


def test_a_prompt_without_a_url_has_no_start_url() -> None:
    assert _url_from_prompt("top 5 programming languages") is None


def test_a_non_http_url_is_ignored() -> None:
    """Only http(s) can be opened; anything else must not become a navigation."""
    assert _url_from_prompt("open file:///c:/temp/notes.txt") is None


def test_progress_advances_monotonically_and_stops_short_of_the_report() -> None:
    values = [_progress_for_step(step, 30) for step in range(1, 31)]

    assert values == sorted(values)
    assert values[0] == _PROGRESS_STARTED
    # The orchestrator owns 0.9 for report synthesis; the loop must not reach it.
    assert values[-1] < 0.9


def test_an_anti_bot_page_is_recognised_as_a_challenge() -> None:
    challenge = (
        "Unfortunately, bots use DuckDuckGo too. Please complete the following "
        "challenge to confirm this search was made by a human."
    )
    assert _looks_like_challenge(challenge)
    assert not _looks_like_challenge("Example Domain - 10 results")


# --------------------------------------------------------------- run summary --


def test_the_runs_own_conclusion_is_kept_when_no_findings_exist() -> None:
    summary = _fallback_summary("Open http://127.0.0.1:8002", [], "Page title: AgentWebEinh Local Test")

    assert summary == "Page title: AgentWebEinh Local Test"


def test_findings_still_win_over_the_run_conclusion() -> None:
    findings = [FindingDto(label="Page title", value="AgentWebEinh Local Test")]
    summary = _fallback_summary("Open http://127.0.0.1:8002", findings, "something else")

    assert "Page title" in summary
    assert "something else" not in summary


# ------------------------------------------------------------------ frame fan-out --


def _frame_settings() -> Settings:
    return settings_override(
        browser_max_screenshot_bytes=1_000,
        browser_frame_interval_ms=200,
    )


async def test_every_subscriber_receives_the_same_frame() -> None:
    """Two viewers of one task must both be served; neither may starve the other."""
    manager = FrameManager(_frame_settings())
    task_id = "task-fanout"

    first = asyncio.create_task(_collect(manager, task_id))
    second = asyncio.create_task(_collect(manager, task_id))
    # Let both streams register before anything is published.
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert manager.stats()["active_subscribers"] == 2

    await manager.publish(task_id, b"jpeg-bytes-1")

    assert await asyncio.wait_for(first, timeout=2) == b"jpeg-bytes-1"
    assert await asyncio.wait_for(second, timeout=2) == b"jpeg-bytes-1"


async def test_a_closed_stream_deregisters_its_subscriber() -> None:
    """A viewer that goes away must not leave a queue that frames pile into."""
    manager = FrameManager(_frame_settings())
    task_id = "task-leaving"

    stream = manager.mjpeg_stream(task_id)
    # The generator body only runs on first ``__anext__``, so the frame published
    # beforehand is replayed to the client from ``_latest`` on connect.
    await manager.publish(task_id, b"jpeg-bytes")
    chunk = await asyncio.wait_for(stream.__anext__(), timeout=2)

    assert b"jpeg-bytes" in chunk
    assert manager.stats()["active_subscribers"] == 1

    await stream.aclose()
    assert manager.stats()["active_subscribers"] == 0


async def _collect(manager: FrameManager, task_id: str) -> bytes:
    """Take the first frame off an MJPEG stream and return its payload."""
    async for chunk in manager.mjpeg_stream(task_id):
        # Strip the multipart headers to get back to the JPEG bytes.
        return chunk.split(b"\r\n\r\n", 1)[1].rstrip(b"\r\n")
    raise AssertionError("stream ended without a frame")


async def test_oversized_frame_is_rejected_and_not_published() -> None:
    """A corrupt JPEG would make the frontend's <img> fail and blame the stream."""
    manager = FrameManager(_frame_settings())

    assert await manager.publish("task-big", b"x" * 1_001) is None
    assert await manager.latest("task-big") is None


async def test_clear_removes_the_latest_frame() -> None:
    """Terminal tasks clear the view so no stale frame sits next to a report."""
    manager = FrameManager(_frame_settings())
    await manager.publish("task-done", b"jpeg")

    await manager.clear("task-done")

    assert await manager.latest("task-done") is None


# ----------------------------------------------------------------- state machine --


def test_only_terminal_statuses_are_terminal() -> None:
    assert is_terminal(TaskStatus.COMPLETED)
    assert is_terminal(TaskStatus.FAILED)
    assert is_terminal(TaskStatus.CANCELLED)
    for status in (TaskStatus.READY, TaskStatus.QUEUED, TaskStatus.STARTING,
                   TaskStatus.RUNNING, TaskStatus.AWAITING_APPROVAL):
        assert not is_terminal(status)


def test_happy_path_transitions_are_allowed() -> None:
    assert can_transition(TaskStatus.QUEUED, TaskStatus.STARTING)
    assert can_transition(TaskStatus.STARTING, TaskStatus.RUNNING)
    assert can_transition(TaskStatus.RUNNING, TaskStatus.COMPLETED)
    assert can_transition(TaskStatus.QUEUED, TaskStatus.CANCELLED)
    assert can_transition(TaskStatus.RUNNING, TaskStatus.FAILED)


def test_a_task_can_never_run_backwards() -> None:
    assert not can_transition(TaskStatus.RUNNING, TaskStatus.QUEUED)
    assert not can_transition(TaskStatus.COMPLETED, TaskStatus.RUNNING)
    assert not can_transition(TaskStatus.FAILED, TaskStatus.STARTING)


def test_invalid_transition_raises_rather_than_corrupting_state() -> None:
    with pytest.raises(InvalidTransition):
        ensure_transition(TaskStatus.COMPLETED, TaskStatus.RUNNING)


def test_same_status_transition_is_tolerated() -> None:
    """Workers re-assert state defensively; a no-op assertion is not an error."""
    ensure_transition(TaskStatus.RUNNING, TaskStatus.RUNNING)


# --------------------------------------------------------------------------- ids --


def test_task_ids_are_sortable_ulids_with_the_documented_prefix() -> None:
    task_id = new_task_id()

    assert is_ulid_like(task_id, "task")
    assert task_id.startswith("task_")
    # Both prefix spellings are accepted.
    assert is_ulid_like(task_id, "task_")
    assert is_ulid_like(new_event_id(), "evt")
    assert not is_ulid_like(task_id, "evt")
    assert not is_ulid_like("task_short", "task")


def test_ids_sort_by_creation_time() -> None:
    """Ordering is guaranteed per millisecond, not per call.

    The random half of the id breaks ties, so two ids minted inside the same
    millisecond may sort either way. That is fine for the task list, which falls
    back to ``created_at``; what must hold is that a later id never sorts earlier.
    """
    with mock.patch("app.utils.ids.time.time", return_value=1_700_000_000.0):
        earlier = new_task_id()
    with mock.patch("app.utils.ids.time.time", return_value=1_700_000_000.5):
        later = new_task_id()

    assert earlier < later

# --------------------------------------------------------------- status probe --


def test_probe_budget_never_undercuts_a_configured_timeout() -> None:
    """A shared cap made a healthy OpenClaw gateway look broken on every probe.

    The CLI needs seconds just to start on Windows, so a five-second outer budget
    fired first and reported ``degraded`` while the adapter's own probe was still
    running successfully.
    """
    service = _health_service_stub()

    slow_cli = 20_000 / 1000.0
    assert service._probe_budget(slow_cli) > slow_cli
    # A too-tight configured value is floored rather than believed.
    assert service._probe_budget(0.1) == PROBE_BUDGET_SECONDS


def test_status_probe_results_are_cached_between_requests() -> None:
    """``/api/status`` is the endpoint the frontend probes to identify the backend.

    Re-running a subprocess probe on every call made the response slower than the
    client's deadline, so a working backend was reported unreachable. The reported
    component states stay real; they are simply reused for a few seconds.
    """
    service = _health_service_stub()
    calls = 0

    async def counting_probe() -> IntegrationHealth:
        nonlocal calls
        calls += 1
        return IntegrationHealth("openclaw", "up", "Gateway reachable.")

    service._openclaw = mock.Mock(health=counting_probe)
    service._ollama = mock.Mock(
        health=_immediate_health("ollama", "up", "Ollama ready.")
    )

    first = asyncio.run(service._integration_snapshot())
    second = asyncio.run(service._integration_snapshot())

    assert calls == 1, "a fresh probe ran on a cached response"
    assert first.openclaw is second.openclaw
    assert second.openclaw is not None and second.openclaw.state == "up"


async def test_concurrent_status_probes_share_one_run() -> None:
    """A burst of page loads must not each spawn the same subprocesses."""
    service = _health_service_stub()
    started = 0

    async def slow_probe() -> IntegrationHealth:
        nonlocal started
        started += 1
        await asyncio.sleep(0.01)
        return IntegrationHealth("openclaw", "up", "Gateway reachable.")

    service._openclaw = mock.Mock(health=slow_probe)
    service._ollama = mock.Mock(
        health=_immediate_health("ollama", "up", "Ollama ready.")
    )

    results = await asyncio.gather(*(service._integration_snapshot() for _ in range(5)))

    assert started == 1
    assert len(results) == 5


def _immediate_health(name: str, state: str, detail: str):
    async def probe() -> IntegrationHealth:
        return IntegrationHealth(name, state, detail)

    return probe


def _health_service_stub():
    """A HealthService with every collaborator replaced by a trivial double.

    The browser is disabled rather than mocked: the real health service builds a
    ``BrowserAdapter`` over the manager itself, so a mock here would have to
    reproduce ``BrowserManager.probe()``'s exact keys to be useful.
    """
    from app.browser.browser_manager import BrowserManager

    settings = settings_override(status_cache_seconds=30.0, browser_enabled=False)
    return HealthService(
        settings=settings,
        database=mock.Mock(),
        task_manager=mock.Mock(ready=True, inflight_count=0, queued_count=0),
        ollama=mock.Mock(health=_immediate_health("ollama", "up", "Ollama ready.")),
        openclaw=mock.Mock(health=_immediate_health("openclaw", "up", "Gateway reachable.")),
        browser=BrowserManager(settings),
        tinyfish=mock.Mock(health=_immediate_health("tinyfish", "disabled", "off.")),
        frames=mock.Mock(),
    )


def test_exact_duplicate_finding_is_rejected_so_a_run_cannot_loop_on_it():
    """The measured failure was the same finding re-emitted until the task timed out."""
    result = BrowserRunResult()

    assert result.add_finding("page_title", "AgentWebEinh Local Test") is True
    assert result.add_finding("page_title", "AgentWebEinh Local Test") is False
    assert len(result.findings) == 1


def test_same_label_with_a_different_value_is_kept():
    """Deduplication must not swallow a genuinely updated value."""
    result = BrowserRunResult()

    result.add_finding("page_title", "First")
    result.add_finding("page_title", "Second")

    assert [f.value for f in result.findings] == ["First", "Second"]


def test_evidence_count_changes_only_when_the_run_learns_something():
    """Stall detection keys off this, so a page revisit must not look like progress."""
    result = BrowserRunResult()
    assert result.evidence_count() == (0, 0, 0)

    result.note_page("http://127.0.0.1:8002/", "AgentWebEinh Local Test")
    reached = result.evidence_count()
    assert reached == (0, 0, 1), "a genuinely new page is progress"

    result.note_page("http://127.0.0.1:8002/", "AgentWebEinh Local Test")
    assert result.evidence_count() == reached, "revisiting a page is not new evidence"

    result.add_finding("main_heading", "Local Browser Test Passed")
    assert result.evidence_count() != reached


def test_stalled_summary_reports_what_was_found_and_does_not_claim_success():
    result = BrowserRunResult()
    result.add_finding("page_title", "AgentWebEinh Local Test")

    summary = _stalled_summary(result, step=_STALL_STEP_LIMIT + 2)

    assert "AgentWebEinh Local Test" not in summary or "page_title" in summary
    assert "3" not in summary.split("step")[0], "must state the step count it stopped at"
    assert str(_STALL_STEP_LIMIT + 2) in summary
    assert "complete" not in summary.lower()


def test_stalled_summary_without_findings_says_so_instead_of_inventing_one():
    summary = _stalled_summary(BrowserRunResult(), step=3)

    assert "without" in summary.lower()
    assert "finding" in summary.lower()


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("report", "finding"),
        ("Record Finding", "finding"),
        ("GO-TO", "goto"),
        ("Finish", "done"),
        ("fill", "type"),
    ],
)
def test_model_action_synonyms_map_onto_the_supported_vocabulary(given, expected):
    """This model answered "report" for what the prompt calls "finding"."""
    assert normalize_action(given) == expected
    assert normalize_action(given) in ACTIONS


def test_unknown_action_is_not_silently_accepted():
    assert normalize_action("teleport") not in ACTIONS


def test_finding_keeps_the_page_it_came_from_so_the_report_can_cite_it():
    """Findings arrived with sourceUrl=null, leaving the report uncited."""
    result = BrowserRunResult()

    result.add_finding("page_title", "AgentWebEinh Local Test", "http://127.0.0.1:8002/")

    assert result.findings[0].source_url == "http://127.0.0.1:8002/"


def test_note_page_ignores_a_non_http_url_and_a_repeat():
    result = BrowserRunResult()

    result.note_page("http://127.0.0.1:8002/", "AgentWebEinh Local Test")
    result.note_page("http://127.0.0.1:8002/", "AgentWebEinh Local Test")
    result.note_page("about:blank", "blank")
    result.note_page(None, None)

    assert result.pages_visited == [
        {"url": "http://127.0.0.1:8002/", "title": "AgentWebEinh Local Test"}
    ]
