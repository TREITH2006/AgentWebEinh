# AgentWebEinh

Describe a task, and a local agent drives a real browser to carry it out while the
interface streams the run back: live frames, an activity feed, and a sourced report.

The repository contains a **Next.js frontend** and a **FastAPI backend** that
implements the contract the frontend was written against.

## Status

| Part | State |
| --- | --- |
| Frontend | Complete. Builds clean, runs standalone in demo mode. |
| Backend | Implemented and covered by 55 in-process tests. |
| Browser automation | Native Playwright + Ollama loop. Runtime-verified only when a browser and model are present. |
| OpenClaw / TinyFish | Optional integrations, disabled by default, off in the test suite. |

The frontend also runs with **no backend at all**, in demo mode, driven by
deterministic fixtures. It falls back to demo automatically whenever `/health` is
not reachable, so the whole product is explorable before anything is installed.

## Quick start

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>. With no configuration the app starts in demo mode
and every screen is usable.

### Backend

```bash
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m app.cli init-db   # create the SQLite schema
.\.venv\Scripts\python -m uvicorn app.main:app --reload
```

The API is then on <http://127.0.0.1:8000>, with interactive docs at `/docs`.

Every setting is an `AWE_*` environment variable; see
[`backend/.env.example`](backend/.env.example). The defaults run with no
configuration at all.

### Wiring them together

```bash
cd frontend
cp .env.example .env.local
# set NEXT_PUBLIC_API_MODE=live and NEXT_PUBLIC_API_PROXY_TARGET=http://127.0.0.1:8000
npm run dev
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |

| Backend command | Purpose |
| --- | --- |
| `python -m app.cli init-db` | Create tables if absent; never drops data |
| `python -m app.cli config` | Print the resolved configuration |
| `python -m app.cli routes` | List the registered HTTP routes |

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Dashboard: composer, live workspace, report |
| `/tasks` | Searchable history of every run |
| `/tasks/[taskId]` | One run in full: report, browser activity, event stream |
| `/analytics` | Volume, outcomes and duration trends |
| `/about` | What it does, how a task flows, the rules the UI follows |

## Architecture

```
frontend/src/
  app/                     routes; server components for copy, clients for behaviour
  components/              analytics, dashboard, layout, charts, tasks, task, ui
  lib/
    api/                   client, endpoints, normalisers, transports, service
    demo/                  fixtures, simulator, in-memory repository
    hooks/                 useTaskRunner, useTaskHistory, useTaskDetail, useStats
    data-source.tsx        live/demo resolution and the shared service handle
    config.ts              NEXT_PUBLIC_* configuration
    status.ts              status and event vocabulary shared across the UI
  styles/                  tokens, base, the single motion library
  types/                   domain model and wire DTOs

backend/app/
  main.py                  composition root, lifespan, CORS, shutdown
  cli.py                   schema/config/routes commands
  config.py                AWE_* settings
  errors.py                the JSON error envelope the frontend expects
  schemas/                 wire DTOs and the closed status/event vocabularies
  database/                async SQLite engine, models, repositories
  core/                    state machine, task manager, event manager, orchestrator
  adapters/                Ollama, OpenClaw, TinyFish, browser
  browser/                 Playwright lifecycle, frame store, event emitter
  services/                task, report, metrics, health
  api/                     routers and dependency wiring
```

Layering rules, enforced by review rather than by tooling:

1. `components/**` never calls `fetch`. Data comes from `lib/hooks`.
2. `lib/api` never returns a raw DTO — everything passes through `normalize.ts`.
3. Demo code is confined to `lib/demo` and reached only through the same service
   interface the live backend implements.
4. All motion keyframes live in `styles/animations.css`; components may only
   reference them.
5. Brand colours come from `styles/tokens.css`. No hex values in components.

The chart kit is dependency-free SVG. The interface uses **no animation or UI
library** — the button, loaders, search field and charts are all local, so the
visual language is consistent and the bundle stays small.

## Two data sources, never mixed

**Live mode** — every value on screen comes from the backend: REST for reads and
commands, WebSocket (with polling fallback) for events, browser frames over MJPEG.

**Demo mode** — deterministic fixtures with a scripted simulator, so the product
can be explored with no backend at all. It is visibly marked everywhere: a header
banner, a `Simulated` badge on every affected record, and `Demo fixtures` on
analytics.

Switch between them with the data-source control in the header, or pin the mode
with `NEXT_PUBLIC_API_MODE`. In `auto` mode the app probes `/health` and falls
back to demo if the backend is unreachable.

The two modes share one code path. There is no second UI.

### Rules the interface follows

- **Never invent data.** No placeholder screenshots, no fabricated progress
  bars, no made-up findings. A missing capability is stated plainly.
- **Label the origin.** Nothing is ever presented as live data when it is not.
- **`progress: null` is honoured.** A null ratio renders an indeterminate bar and
  a "progress not reported" note, never a guessed percentage.
- **No fake browser view.** Without a frame feed, the browser panel says so and
  still shows the page the agent reported being on.

## How a task runs

1. `POST /api/tasks` returns `201` with a task id and `queued` immediately —
   submission never waits for a browser or a model to warm up.
2. A worker moves the task `queued → starting → running`, emitting an event at
   each step. Every published event carries a **full task snapshot**, so the
   interface never has to infer status from an event type.
3. The engine runs: the native browser loop, an OpenClaw research pass, or both.
4. The report is synthesised from collected evidence only, then the terminal
   status **and** the report are committed together before the terminal event is
   published. A client that only sees the event can already fetch the report.
5. `cancelled`, `failed` and `completed` are terminal and never change.

`GET /api/tasks/{id}/events` is a complete, replayable history including events
published while nothing was connected. `POST /api/tasks/{id}/cancel` returns
`202`: cancellation is a request, and the final status arrives on the stream.

### Restart behaviour

Tasks left `starting`/`running`/`awaiting_approval` by a crash are marked `failed`
at startup. Tasks still `queued` are re-queued and run again.

## Safety notes

- Webpage content is treated as untrusted data. The model may only emit a fixed
  set of actions, and navigation accepts absolute `http(s)` URLs only.
- Optional integrations degrade softly. A down gateway, model, or search CLI is
  reported in `/health` but never fails `/health` and never fails a task.
- Subprocesses run without a shell, with timeouts, output redaction, and cleanup.
- OpenClaw runs under a per-task session (`agent:main:awe-<task_id>`) so a live
  personal session is never taken over, and nothing is ever delivered to a channel.

## Accessibility

Semantic landmarks and heading order, labelled controls, visible focus rings,
`aria-live` on status and progress regions, keyboard submission and clearing in
the composer, and a full `prefers-reduced-motion` path that disables the
transition-heavy effects while keeping state changes legible.

## Tests

```bash
cd backend
.\.venv\Scripts\python -m pytest        # 55 tests, no servers, no external calls
.\.venv\Scripts\python -m ruff check app tests
```

The suite runs entirely in-process against a temporary database with a stubbed
orchestrator: it never launches Chromium, calls a model, invokes OpenClaw, or uses
a paid API. It covers the HTTP contract, WebSocket framing, cancellation, the state
machine, and static guards that every referenced enum member exists.

```bash
cd frontend
npx tsc --noEmit
npm run build
```

## Configuration

Backend variables are documented in [`backend/.env.example`](backend/.env.example)
and frontend variables in [`frontend/.env.example`](frontend/.env.example). Both
sides run with sensible defaults and no configuration at all.

The wire contract is specified in [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).