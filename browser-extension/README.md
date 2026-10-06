# AgentWebEinh Browser Extension

Chrome Extension (Manifest V3) for AgentWebEinh.

**Status: Phase 2C — Paired Browser Engine over a WebSocket bridge.**

## What this is

An isolated, standalone npm project under `browser-extension/` that produces a
Chrome-loadable Manifest V3 extension. The extension receives strongly typed
browser commands (over the WebSocket bridge from the FastAPI backend, or the
internal message channel for local testing), executes them against the real
Chrome browser through a Browser Controller, and returns structured results.
No evaluation, no automation of other sites' servers — the extension is the
page operator the AgentWebEinh task engine drives.

## Phase 2C scope

- **WebSocket bridge** (`src/websocket/connection.ts`, `src/websocket/bridge.ts`):
  a resilient socket to the backend's `/api/browser/ws` endpoint with pairing,
  exponential-backoff reconnect, heartbeats and a bounded outbox.
- **Pairing**: `POST /api/browser/pairing` on the backend mints an 8-char,
  single-use code; the popup opens the socket and sends `{type:"pair", code}`;
  the backend answers `paired` with a `connection_id` that every later
  `browser_result` must echo. Rejected codes are cleared so the client does not
  retry a broken credential forever.
- **Command relay**: inbound `browser_command` frames run through the existing
  `BrowserController` (same queueing/cancellation/typing as Phase 2B); the
  `BrowserResult` is sent back as `browser_result` with the matching
  `action_id`. A `stop` frame cancels the active action.
- **GET_PAGE enriched** to mirror the backend's observation: in addition to
  `url`/`title`/`text`/`truncated`, it now returns `headings: string[]`
  (`h<n>: <text>`) and `elements: [{index, selector, tag, role, text}]`
  (bounded by `MAX_PAGE_HEADINGS` = 30 and `MAX_PAGE_ELEMENTS` = 60,
  visible-only, best-effort CSS selectors).
- **Popup**: backend URL field (default
  `ws://127.0.0.1:8001/api/browser/ws`, persisted in `chrome.storage`), pairing
  code field, "Pair browser" / "Disconnect", live status via
  `CONNECTION_CHANGED` events broadcast by the bridge.

The command vocabulary is unchanged and fixed: `OPEN_URL`, `CLICK`, `TYPE`,
`SCROLL`, `BACK`, `NEW_TAB`, `GET_PAGE`, `SCREENSHOT`, `STOP`. There is no
`PRESS`; the backend surfaces that as an explicit unsupported operation so the
model clicks a submit button instead of assuming Enter worked.

### Wire protocol (client side)

```
client → {type:"pair", code, name}
client → {type:"ping"}                     (heartbeat, every 20 s)
client → {type:"browser_result", task_id, action_id, connection_id,
           success: true, data } | { success: false, error: {code, message} }
server → {type:"paired", browser_id, connection_id, name}
server → {type:"browser_command", task_id, action_id, connection_id, command}
server → {type:"stop", task_id}
server → {type:"error", code, message}     (e.g. pairing_rejected)
server → {type:"pong"}
```

### Command flow

```
browser_command (WebSocket)
   ↓
WireBridge               (src/websocket/bridge.ts — pairing state, dispatch, results)
   ↓
Browser Controller       (src/browser/controller.ts — queue, cancellation, handlers)
   ↓
Chrome APIs / Content Script (src/browser/tabs.ts, content-channel.ts)
   ↓
Real Chrome
   ↓
BrowserResult → browser_result (WebSocket, echoes action_id + connection_id)
```

- Commands are validated by `src/protocol/browser-commands.ts`
  (`parseBrowserCommand`) before any browser API is touched.
- Commands execute one at a time on an internal queue; `STOP` cancels the
  active command's `CancelToken` and marks queued commands as cancelled.
- DOM operations (`CLICK`, `TYPE`, `SCROLL`, `GET_PAGE`) run in the content
  script via the `PAGE_OP` message protocol (`src/protocol/page-ops.ts`).
  If the content script is missing (tab opened before install), the
  controller injects it on demand with `chrome.scripting`.
- `GET_PAGE` text is bounded to 15 000 chars (`MAX_PAGE_TEXT_CHARS`) with a
  `truncated` flag; headings (30) and elements (60) are likewise bounded.
- `SCREENSHOT` uses `chrome.tabs.captureVisibleTab` and returns a
  `data:image/...` data URL kept local/in-memory — uploaded only as a
  `browser_result` payload for the single task that holds the lease.

### Error handling

All failures resolve to a `FailureResult` with a typed error code — a failed
command never crashes the service worker:

`INVALID_COMMAND`, `INVALID_INPUT`, `INVALID_URL`, `TAB_NOT_FOUND`,
`ELEMENT_NOT_FOUND`, `PAGE_NOT_READY`, `NAVIGATION_FAILURE`,
`CONTENT_SCRIPT_UNAVAILABLE`, `PERMISSION_FAILURE`, `SCREENSHOT_FAILURE`,
`UNSUPPORTED_OPERATION`, `CANCELLED`, `INTERNAL_ERROR`.

## Permissions

| Permission / match           | Why |
| ---------------------------- | --- |
| `tabs`                       | Read the active tab's `url`/`title` for command results and navigation settling; navigate/create tabs (`OPEN_URL`, `BACK`, `NEW_TAB`); `captureVisibleTab` for `SCREENSHOT`. |
| `scripting`                  | On-demand content-script injection when a tab predates installation (`chrome.scripting.executeScript`), so DOM commands work without reloading tabs. |
| `host_permissions: http://*/*, https://*/*` | The browser-control layer must act on whatever http/https page is active — the whole point of a browser agent. Needed for content-script messaging/injection and `captureVisibleTab` on those pages. **Not** `<all_urls>`: `file://`, `chrome://`, `ftp://`, etc. are deliberately excluded. |
| `content_scripts` matches `http://*/*, https://*/*` (`all_frames: false`, `document_idle`) | DOM operations (`CLICK`, `TYPE`, `SCROLL`, `GET_PAGE`) require page access. Top frame only — no iframe injection. |

Security posture: no `eval`, no `new Function`, no arbitrary-JS execution
commands, no cookies/history/telemetry APIs — the only network channel is the
single WebSocket to the configured backend (pairing-protected, one command in
flight, `connection_id` checked on every result). `TYPE` text is never logged;
results carry only its length. The socket reconnects with capped backoff and
never re-pairs with a rejected code.

## Structure

```
browser-extension/
├── manifest.json          # MV3 source of truth (copied into dist/ at build)
├── package.json           # scripts: dev, build, typecheck
├── vite.config.ts         # two builds: main (ES) + content (IIFE)
├── tsconfig.json
├── scripts/
│   ├── dev.mjs            # runs both vite watch builds in parallel
│   ├── clean.mjs          # removes dist/
│   └── make-icons.py      # generates public/icons/*.png (no dependencies)
├── public/icons/          # icon16/32/48/128.png
├── src/
│   ├── background/service-worker.ts   # routing: control commands, BROWSER_COMMAND, bridge start
│   ├── content/content-script.ts      # PAGE_OP handlers: CLICK/TYPE/SCROLL/GET_PAGE/PING
│   ├── popup/                         # popup.html / popup.ts / popup.css (pairing UI)
│   ├── protocol/
│   │   ├── browser-commands.ts        # command union + input validation
│   │   ├── results.ts                 # BrowserResult / data maps
│   │   ├── page-ops.ts                # SW ↔ content script message protocol
│   │   ├── errors.ts                  # typed error codes
│   │   ├── commands.ts                # PING / GET_STATUS / SET_BACKEND_URL / PAIR / UNPAIR
│   │   └── events.ts                  # status + connection-changed events
│   ├── browser/
│   │   ├── controller.ts              # BrowserController (queue, STOP, handlers)
│   │   ├── tabs.ts                    # tab helpers + navigation settle
│   │   ├── content-channel.ts         # PAGE_OP transport + injection fallback
│   │   ├── errors.ts                  # CancelToken, BrowserCommandError
│   │   └── navigation/interaction/extraction/screenshot.ts  # Phase 2A contracts
│   ├── websocket/
│   │   ├── connection.ts              # resilient WebSocket client (reconnect, heartbeat, outbox)
│   │   └── bridge.ts                  # WireBridge: pairing state, dispatch, browser_result
│   └── types/index.ts
└── dist/                  # build output — load this into Chrome
```

## Install / Build / Load

```
npm install          # dev deps: vite, typescript, @types/chrome, @types/node
npm run typecheck    # tsc --noEmit
npm run build        # clean + main build + content build → dist/
npm run dev          # both builds in watch mode
```

Load into Chrome: `chrome://extensions` → Developer mode → **Load unpacked**
→ select `browser-extension/dist/`.

## Pairing a browser

1. Run the backend (default `ws://127.0.0.1:8001/api/browser/ws`).
2. Mint a code: `POST /api/browser/pairing` (or the website's "Connect a
   browser" page).
3. Open the extension popup, paste the 8-char code (the backend URL field
   defaults to the local backend; set it to the proxied
   `/ws/backend/api/browser/ws` path for a Vercel-deployed backend), press
   **Pair browser**.
4. The popup shows **Paired**; `GET /api/browser/status` lists the peer. A
   task submitted with the extension engine enabled will now drive this Chrome.

## Local command channel (unchanged)

```ts
chrome.runtime.sendMessage({
  type: 'BROWSER_COMMAND',
  requestId: 'req-1',
  command: { command: 'OPEN_URL', url: 'https://example.com' },
});
// → BrowserResult: { success: true, command: 'OPEN_URL', requestId, timestamp,
//                    data: { tabId, url, title } }
```

## Verification

Phase 2A: typecheck, build, unpacked load, service worker start, popup text,
`PING`/`GET_STATUS` round-trip — all passed.

Phase 2B: `tsc --noEmit` passes; `vite build` passes; `dist/` references all
resolved; bundles free of `eval`/`new Function`; `GET_PAGE` returns only local
page text (no elements, no headings).

Phase 2C: `tsc --noEmit` passes; `vite build` passes; the shared module chunk
(`assets/events-*.js`) resolves for both the service worker and the popup; no
`eval`/`new Function` in any bundle; `new WebSocket` present only in the
service-worker bundle; GET_PAGE now returns headings + elements additively.

## Next phase

**Phase 2D — Live execution events** (reuse existing task-event/frame stream;
extension emits voluntary page notifications logged by the bridge).