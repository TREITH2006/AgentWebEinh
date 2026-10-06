"""``/api/browser`` — pairing codes, bridge status, and the extension socket.

The website's "Connect a browser" page calls ``POST /pairing`` to mint a code;
the user types that code into the extension popup; the extension opens this
WebSocket and sends ``{type: "pair", code: ...}``. From then on the bridge routes
``browser_command`` messages to that socket and the extension answers with
``browser_result`` (see ``app.browser.browser_bridge``).

Wire protocol (extension side of the socket):

* client → ``pair`` ``ping`` ``browser_result`` ``browser_event``
* server → ``paired`` ``browser_command`` ``stop`` ``error`` ``pong``

A socket that does not pair within a short window is closed so dead connections
cannot linger unauthenticated.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect, status

from ..browser.browser_bridge import (
    CLOSE_PAIRING_REJECTED,
    CLOSE_UNPAIRED_TIMEOUT,
    PAIR_WINDOW_SECONDS,
    BrowserBridge,
    PairingRejected,
)
from ..config import Settings
from ..schemas.browser import (
    BrowserPeerDto,
    BrowserStatusResponse,
    PairingResponse,
    WebSocketUrlDto,
)

logger = logging.getLogger("agentwebeinh.api.browser_ws")

router = APIRouter(prefix="/api/browser", tags=["browser-extension"])

#: The path the extension dials. The Vercel proxy relays ``/ws/backend/<path>``
#: transparently, so either ``ws://<backend>/api/browser/ws`` or the proxied
#: ``/ws/backend/api/browser/ws`` reach the same handler.
WEBSOCKET_PATH = "/api/browser/ws"


def _websocket_urls(settings: Settings) -> list[WebSocketUrlDto]:
    """Concrete socket addresses for the extension popup.

    The popup takes a full ``ws(s)://`` URL, so the page hands the user the two
    that actually work rather than a bare path they would have to complete
    themselves: loopback when Chrome runs next to the backend (the fast, private
    default) and the public route when it does not.
    """
    urls: list[WebSocketUrlDto] = [
        WebSocketUrlDto(
            label="This computer",
            url=f"ws://127.0.0.1:{settings.port}{WEBSOCKET_PATH}",
            note="Use this when Chrome runs on the same machine as the backend.",
        ),
    ]
    public = settings.public_base_url.rstrip("/")
    if public:
        scheme = "wss" if public.startswith("https://") else "ws"
        origin = public.split("://", 1)[1]
        urls.append(
            WebSocketUrlDto(
                label="Public route",
                url=f"{scheme}://{origin}{WEBSOCKET_PATH}",
                note="Use this when Chrome runs on another device.",
            )
        )
    return urls


def _bridge(request: Request | WebSocket) -> BrowserBridge:
    return request.app.state.browser_bridge


@router.post(
    "/pairing",
    response_model=PairingResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a browser pairing code",
)
async def create_pairing(request: Request) -> PairingResponse:
    """Mint a short-lived, single-use code for the extension popup."""
    bridge: BrowserBridge = _bridge(request)
    settings: Settings = request.app.state.settings
    code = bridge.issue_pairing()
    return PairingResponse(
        code=code.code,
        expires_at=code.expires_at,
        ttl_seconds=settings.browser_extension_pairing_ttl_seconds,
        websocket_endpoint=WEBSOCKET_PATH,
        websocket_urls=_websocket_urls(settings),
    )


@router.get("/status", response_model=BrowserStatusResponse, summary="Extension bridge status")
async def browser_status(request: Request) -> BrowserStatusResponse:
    """List currently paired browser extensions."""
    bridge: BrowserBridge = _bridge(request)
    settings: Settings = request.app.state.settings
    return BrowserStatusResponse(
        enabled=settings.browser_extension_enabled,
        agent_mode=settings.browser_extension_agent,
        pairing=settings.browser_extension_enabled,
        paired=[BrowserPeerDto(**peer) for peer in bridge.describe_peers()],
        websocket_endpoint=WEBSOCKET_PATH,
        websocket_urls=_websocket_urls(settings),
    )


@router.websocket("/ws")
async def extension_socket(websocket: WebSocket) -> None:
    """Long-lived command channel for one paired browser extension."""
    bridge: BrowserBridge = websocket.app.state.browser_bridge
    await websocket.accept()

    peer = await _wait_for_pair(websocket, bridge)
    if peer is None:
        with contextlib.suppress(Exception):
            await websocket.close(code=CLOSE_UNPAIRED_TIMEOUT)
        return

    try:
        await _pump(websocket, bridge, peer)
    except WebSocketDisconnect:
        logger.debug("extension_socket_disconnected browser_id=%s", peer.browser_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("extension_socket_error browser_id=%s error=%s",
                         peer.browser_id, type(exc).__name__)
    finally:
        await bridge.unregister(peer)


async def _wait_for_pair(websocket: WebSocket, bridge: BrowserBridge) -> Any:
    """Read until the client sends ``pair``; returns the peer or ``None``.

    A rejected code closes the socket immediately so a brute-force code guess is
    cut off instead of ballasted by a heartbeat loop.
    """
    try:
        while True:
            payload = await asyncio.wait_for(_recv_json(websocket), timeout=PAIR_WINDOW_SECONDS)
            if isinstance(payload, dict) and payload.get("type") == "pair":
                code = str(payload.get("code") or "").strip().upper()
                name = str(payload.get("name") or "")
                # Chrome's extension id is stable per install, so the same
                # extension can re-pair after a dropped socket while a different
                # one is still refused with "already used".
                extension_id = str(payload.get("extension_id") or "")
                try:
                    peer = await bridge.redeem(code, websocket, name, extension_id)
                except PairingRejected as exc:
                    logger.info("pairing_rejected reason=%s", exc)
                    with contextlib.suppress(Exception):
                        await websocket.send_json({
                            "type": "error",
                            "code": "pairing_rejected",
                            "message": str(exc),
                        })
                    with contextlib.suppress(Exception):
                        await websocket.close(code=CLOSE_PAIRING_REJECTED)
                    return None
                await websocket.send_json({
                    "type": "paired",
                    "browser_id": peer.browser_id,
                    "connection_id": peer.connection_id,
                    "name": peer.display_name,
                })
                logger.info("extension_paired browser_id=%s name=%s",
                            peer.browser_id, peer.display_name)
                return peer
            if isinstance(payload, dict) and payload.get("type") == "ping":
                with contextlib.suppress(Exception):
                    await websocket.send_json({"type": "pong"})
    except TimeoutError:
        logger.warning("extension_pair_window_expired no_pair_before_timeout")
        return None


async def _pump(websocket: WebSocket, bridge: BrowserBridge, peer: Any) -> None:
    """Forward extension messages to the bridge (results) or the event stream."""
    while True:
        payload = await _recv_json(websocket)
        if not isinstance(payload, dict):
            continue
        kind = payload.get("type")
        if kind == "browser_result":
            bridge.resolve_result(peer, payload)
        elif kind == "browser_event":
            # Voluntary page notifications from the extension.
            # Handle frame events to enable live screen.
            task_id = payload.get("task_id")
            event_type = payload.get("event") or payload.get("name")
            if task_id and event_type == "frame":
                data = payload.get("data") or {}
                image_data = data.get("image") or data.get("dataUrl") or data.get("data")
                if isinstance(image_data, str) and image_data.startswith("data:image"):
                    # Extract base64 bytes from data URL
                    try:
                        comma = image_data.find(",")
                        if comma >= 0:
                            b64 = image_data[comma + 1 :]
                            frame_bytes = __import__("base64").b64decode(b64)
                            frames = websocket.app.state.frames
                            if hasattr(frames, "publish"):
                                await frames.publish(
                                    task_id,
                                    frame_bytes,
                                    url=data.get("url"),
                                    title=data.get("title"),
                                    width=data.get("width"),
                                    height=data.get("height"),
                                )
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("frame_publish_failed task_id=%s error=%s", task_id, exc)
                else:
                    logger.debug("frame_no_image_data task_id=%s", task_id)
            logger.debug(
                "extension_event browser_id=%s task_id=%s event=%s",
                peer.browser_id, payload.get("task_id"), payload.get("event"),
            )
        elif kind == "ping":
            with contextlib.suppress(Exception):
                await websocket.send_json({"type": "pong", "timestamp": _now_ms()})
        else:
            logger.debug("extension_unhandled_message browser_id=%s type=%r",
                         peer.browser_id, kind)


async def _recv_json(websocket: WebSocket) -> Any:
    """Read a JSON message without raising on a malformed frame."""
    try:
        return await websocket.receive_json()
    except Exception:  # noqa: BLE001 - a bad frame must not kill the socket
        return None


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


__all__ = ["router"]
