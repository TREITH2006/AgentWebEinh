"""Smoke tests: the app assembles, starts, answers, and shuts down.

These are the checks that would have caught a broken composition root. They run
entirely in-process against a temporary database and a stubbed orchestrator, so
nothing external is contacted.
"""

from __future__ import annotations

from typing import Any

import pytest


def test_app_builds_with_every_contract_route(app: Any) -> None:
    """Every documented endpoint must be registered."""
    paths = set(app.openapi()["paths"])
    assert {
        "/health",
        "/api/status",
        "/api/stats",
        "/api/tasks",
        "/api/tasks/{task_id}",
        "/api/tasks/{task_id}/cancel",
        "/api/tasks/{task_id}/events",
        "/api/tasks/{task_id}/frames",
        "/api/tasks/{task_id}/frame.jpg",
        "/api/tasks/{task_id}/stream.mjpeg",
    } <= paths


def test_health_is_200_and_reports_healthy(client: Any) -> None:
    """The frontend decides live-vs-demo from this status code alone."""
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["healthy"] is True
    assert body["status"] == "healthy"
    assert body["environment"] == "test"
    assert body["components"]["database"]["state"] == "up"
    assert body["components"]["task_manager"]["state"] == "up"
    assert isinstance(body["server_time"], str)


def test_disabled_integrations_do_not_break_health(client: Any) -> None:
    """A missing optional dependency must not flip ``healthy``.

    This is the single most load-bearing health assertion: the frontend falls back
    to demo mode whenever ``/health`` is not 2xx.
    """
    body = client.get("/health").json()
    assert body["healthy"] is True

    for name in ("ollama", "openclaw", "tinyfish", "browser"):
        assert body["components"][name]["state"] == "disabled"


def test_index_is_not_a_404(client: Any) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["health"] == "/health"


def test_empty_task_list_has_the_envelope(client: Any) -> None:
    """``items``/``total`` must be top-level; the frontend reads them directly."""
    body = client.get("/api/tasks").json()
    assert body == {"items": [], "total": 0, "limit": 25, "offset": 0}


def test_stats_on_an_empty_database(client: Any) -> None:
    body = client.get("/api/stats").json()
    assert body["total_tasks"] == 0
    assert body["completed_tasks"] == 0
    assert body["success_rate"] == 0.0
    assert body["range"] == "7d"
    # Buckets are dense: exactly seven days, oldest first, so the chart axis is true.
    assert len(body["buckets"]) == 7
    assert body["buckets"][0]["date"] < body["buckets"][-1]["date"]
    assert all(bucket["performed"] == 0 for bucket in body["buckets"])
    assert body["recent"] == []


def test_unknown_task_is_404_with_the_error_envelope(client: Any) -> None:
    response = client.get("/api/tasks/does-not-exist")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "task_not_found"


def test_unknown_range_falls_back_instead_of_erroring(client: Any) -> None:
    body = client.get("/api/stats?range=nonsense").json()
    assert body["range"] == "7d"


@pytest.mark.parametrize("path", ["/api/tasks/nope/frames", "/api/tasks/nope/frame.jpg"])
def test_frame_endpoints_404_for_unknown_tasks(client: Any, path: str) -> None:
    assert client.get(path).status_code == 404
