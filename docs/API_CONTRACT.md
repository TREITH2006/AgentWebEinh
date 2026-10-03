# AgentWebEinh — backend contract

**Status: implemented.** This document describes the FastAPI backend that lives in
[`backend/`](../backend) and that the frontend in [`frontend/`](../frontend) was
written against. Where the frontend is deliberately lenient — so that a slightly
different backend still works — that is called out explicitly.

Every endpoint below is covered by the in-process contract suite in
[`backend/tests/test_contracts.py`](../backend/tests/test_contracts.py).

---

## 1. Transport

| Concern | Decision |
| --- | --- |
| Style | REST + JSON for reads and commands |
| Real-time | WebSocket at `/api/tasks/{id}/ws`, with polling fallback |
| Authentication | None. The frontend sends no credentials and expects no login flow. |
| CORS | Avoided by design: the frontend proxies through Next.js (`/api/backend/*`, `/ws/backend/*`). An absolute `NEXT_PUBLIC_API_BASE_URL` is supported, and then CORS is the backend's concern. |
| IDs | Opaque strings. The frontend never parses them. |

There is **no SSE endpoint.** The frontend tries the WebSocket first and falls
back to polling, so SSE is not required.

---

## 2. Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and status; decides live vs demo mode |
| `GET` | `/api/status` | Component status without the liveness semantics |
| `POST` | `/api/tasks` | Submit a task |
| `GET` | `/api/tasks` | List tasks (search, filter, sort, paginate) |
| `GET` | `/api/tasks/{id}` | Read one task, including its final report |
| `POST` | `/api/tasks/{id}/cancel` | Request cancellation |
| `GET` | `/api/tasks/{id}/events` | Replayable event history |
| `GET` | `/api/tasks/{id}/events/stream-state` | Stream summary (event count, last sequence) |
| `GET` | `/api/tasks/{id}/frames` | Where to find the browser feed |
| `GET` | `/api/tasks/{id}/frame.jpg` | A single latest JPEG |
| `GET` | `/api/tasks/{id}/stream.mjpeg` | Live MJPEG feed |
| `GET` | `/api/stats?range=7d\|30d\|90d` | Aggregates for the analytics views |
| `WS` | `/api/tasks/{id}/ws` | Live event stream (not in OpenAPI) |

`GET /health` returns **200 whenever the process is up.** A down model, gateway,
or search CLI is reported in the components section and never turns `/health` into
a failure — the frontend would otherwise fall back to demo mode against a backend
that is working exactly as intended.

---

## 3. Statuses

`ready` · `queued` · `starting` · `running` · `awaiting_approval` · `completed` · `failed` · `cancelled`

Terminal: `completed`, `failed`, `cancelled`. A terminal task never changes again,
and a cancellation request against a terminal task does not rewrite its outcome.

The backend emits only these values. On the frontend an unrecognised value
normalises to `ready` rather than crashing a page.

---

## 4. Event types

`task_received` · `agent_started` · `browser_opened` · `page_navigated` ·
`element_inspected` · `action_performed` · `information_collected` ·
`approval_requested` · `task_completed` · `task_failed` · `task_cancelled` ·
`log`

**Events never stand in for status.** The original contract assumed an event
`type` implied a task status, which is why `tool_started` and `status_changed`
once existed. They do not: a task can log, navigate and be inspected while its
status stays `running`, and an interface that infers status from event names
will show the wrong thing.

Instead **every published event carries a complete task snapshot.** The frontend
reads `task.status`, not the event type. Events describe *activity*; the snapshot
describes *state*.

Unknown event types render as a generic activity row, so the vocabulary can grow.

---

## 5. Shapes

Names are the **primary** (snake_case) spelling. The frontend also accepts the
camelCase variant, which is why integration mistakes tend to surface as blank
fields rather than errors.

### Task

```json
{
  "id": "task_01H...",
  "prompt": "Find the three cheapest flights ...",
  "title": "Flights to Lisbon in January",
  "status": "completed",
  "created_at": "2026-01-14T09:12:04Z",
  "started_at": "2026-01-14T09:12:06Z",
  "completed_at": "2026-01-14T09:12:41Z",
  "duration_ms": 35200,
  "progress": 1.0,
  "current_activity": "Summarising results",
  "current_url": "https://example.com/flights",
  "current_title": "Flights to Lisbon",
  "error": null,
  "report": { "...": "see below" }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `progress` | `0..1` or `null` | **`null` is meaningful.** It renders an indeterminate bar and a "progress not reported" note. The frontend never invents a ratio. |
| `error` | object or `null` | `{ "message": string, "code"?: string, "retryable"?: boolean }` |
| `report` | object or `null` | Absent on tasks that never finished. |

### Event

```json
{
  "id": "evt_01H...",
  "task_id": "task_01H...",
  "type": "action_performed",
  "message": "Selected the cheapest result.",
  "at": "2026-01-14T09:12:28Z",
  "url": "https://example.com/flights",
  "detail": "results[0]",
  "data": { "selector": "tr:nth-child(2)" }
}
```

`detail`, `url` and `data` are optional. `message` is expected to be a complete,
human-readable sentence — the frontend renders it verbatim.

### Report

```json
{
  "summary": "Three flights under €420 return on 8–11 January.",
  "actions": [
    {
      "index": 0,
      "at": "2026-01-14T09:12:20Z",
      "label": "Opened the search results page",
      "target": "results table",
      "url": "https://example.com/flights",
      "status": "performed",
      "detail": null
    }
  ],
  "findings": [
    {
      "label": "Cheapest fare",
      "value": "€388 return",
      "note": "Includes one checked bag",
      "source_url": "https://example.com/flights"
    }
  ],
  "sources": [
    {
      "url": "https://example.com/flights",
      "title": "Flights to Lisbon",
      "domain": "example.com",
      "accessed_at": "2026-01-14T09:12:30Z"
    }
  ],
  "limitations": ["Seat selection was not included in the fare."],
  "raw": { "...": "optional untouched payload" }
}
```

Sections may be empty or omitted and the frontend hides whatever is absent. An
optional `report.raw` is shown verbatim behind a disclosure.

**A report may only state what was collected.** Every finding traces to an
observed page, a model observation, or an explicitly named integration reply.
`limitations` is the honest place for everything the run did not establish: if the
agent never loaded the fares table, that is a limitation, never a plausible
inference. When an integration returns unstructured prose it is preserved as
evidence rather than discarded or silently reshaped into invented structure.

### Task list

```json
{ "items": [ /* Task[] */ ], "total": 128, "limit": 25, "offset": 0 }
```

A bare array is also accepted.

### Stats

```json
{
  "total_tasks": 128,
  "completed_tasks": 112,
  "failed_tasks": 9,
  "cancelled_tasks": 7,
  "success_rate": 0.925,
  "average_duration_ms": 28400,
  "buckets": [
    {
      "date": "2026-01-14",
      "performed": 12,
      "completed": 11,
      "failed": 1,
      "cancelled": 0,
      "duration_ms": 29100,
      "success_rate": 0.91
    }
  ],
  "recent": [ /* Task[] */ ]
}
```

`success_rate` is a **ratio in `0..1`**, not a percentage — the charts multiply it
by 100 at render time.

`buckets` and `recent` are **top-level arrays**, not nested under a `daily` or
`trend` object. An earlier shape buried them one level down, which is exactly the
kind of thing that renders as an empty chart rather than an error.

`average_duration_ms` and per-bucket `duration_ms` may be `null`. Charts leave
those points blank rather than interpolating them.

### Frames

```json
{
  "frames_url": "http://127.0.0.1:8000/api/tasks/task_01H.../stream.mjpeg",
  "snapshot_url": "http://127.0.0.1:8000/api/tasks/task_01H.../frame.jpg"
}
```

- `frames_url` — a long-lived image source (MJPEG), rendered in a single `<img>`.
- `snapshot_url` — a single JPEG, polled while the task runs.

Both are **absolute** URLs built from the configured public base URL, because the
frontend renders them in an `<img>` where a relative path resolves against the
Next.js origin, not the API. Both are served with `Cache-Control: no-store` so a
polling client never shows a stale frame.

Both fields may be absent or `null`. When neither is available, the browser panel
says so explicitly and shows the page the agent *reported* being on. **The frontend
never substitutes a placeholder image for a live view.**

---

## 6. Create task

`POST /api/tasks`

```json
{ "prompt": "Find the three cheapest flights ..." }
```

Response — `201`:

```json
{ "id": "task_01H...", "status": "queued", "created_at": "2026-01-14T09:12:04Z" }
```

Submission returns as soon as the task is persisted. It does **not** wait for a
browser to launch or a model to warm up, so a cold start cannot turn into a
gateway timeout. A full Task object is also accepted by the frontend, which only
requires the id.

---

## 7. Streaming

The frontend opens the WebSocket first and falls back to polling
`GET /api/tasks/{id}` when it cannot connect. The transport actually in use is
always shown in the UI.

Each frame is one envelope:

```json
{ "seq": 1, "serverTime": "2026-01-14T09:12:04Z", "task": { /* Task */ } }
{ "seq": 2, "serverTime": "2026-01-14T09:12:06Z", "event": { /* Event */ }, "task": { /* Task */ } }
{ "seq": 3, "serverTime": "2026-01-14T09:12:10Z" }
```

| Rule | Why |
| --- | --- |
| `seq` starts at `1` per connection and increases by exactly 1 | A gap means a frame was lost and the client re-syncs with a full poll. |
| Heartbeats are sequenced too | They are frames on the same ordered channel. An unsequenced heartbeat would make the next real frame look like a gap. |
| The opening frame carries `task` | The interface paints before any event exists. This key was once `snapshot`; the frontend reads `task` and ignored the other, so a connecting client saw an empty first paint. |
| Every event frame also carries `task` | Status always comes from the snapshot, never from the event type (§4). |
| An absent `event`/`task` is a heartbeat | The frontend checks presence, so an explicit `null` is also ignored. |

On reconnect the frontend re-reads `GET /api/tasks/{id}` rather than trying to
resume mid-stream.

### Close codes

| Code | Meaning |
| --- | --- |
| `1000` | The task reached a terminal status. The last frame carries the final snapshot. |
| `4404` | No such task. |
| `1011` | Internal error while streaming. |

### Event history

`GET /api/tasks/{id}/events` returns the **complete, replayable** history,
including events published while nothing was connected, oldest first, and accepts
a `limit`. It is the authority the client re-syncs against after a gap.

---

## 8. Ordering guarantees

Two orderings are load-bearing and are covered by tests:

1. **An event is persisted before it is fanned out.** A client that receives an
   event can always fetch it from history.
2. **The terminal status and the report are committed together, before the
   terminal event is published.** A client that sees `task_completed` can already
   fetch the report — it never observes a completed task whose report 404s.

---

## 9. Restart behaviour

On startup, tasks left `starting`, `running` or `awaiting_approval` by a crash are
marked `failed` with an explanatory error. Tasks still `queued` are re-queued and
run again, because nothing had started executing them.

---

## 10. Cancellation

`POST /api/tasks/{id}/cancel`

`202` means the request was accepted; the task then settles through the normal
stream. `404` or `405` means the backend does not support cancellation — the
frontend then shows "this backend exposes no cancellation route" instead of
pretending the task was stopped. An already-terminal task is not rewritten.

---

## 11. Errors

```json
{
  "error": {
    "code": "task_not_found",
    "message": "No task with that id.",
    "fields": { "prompt": "Required." }
  }
}
```

A bare `{"detail": "..."}` (FastAPI's default) is also accepted. Status codes
`400`, `404`, `409`, `422` and `429` each map to a specific message in the UI.

---

## 12. Frontend compatibility checklist

A backend is compatible when it:

1. answers `GET /health` with a 2xx, whatever the state of its integrations;
2. accepts `POST /api/tasks` and returns an object containing `id`;
3. lists tasks at `GET /api/tasks` as `{ items, total }` or a bare array;
4. serves `GET /api/tasks/{id}` with the task and its report;
5. serves `GET /api/tasks/{id}/events` as an array of events;
6. serves `GET /api/stats` with top-level `buckets` and `recent`, and
   `success_rate` as a ratio;
7. sends a full task snapshot alongside every streamed event.

Cancellation, frames, and the WebSocket transport are optional and degrade with an
explicit UI message.