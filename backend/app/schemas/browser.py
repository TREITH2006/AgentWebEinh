"""Wire DTOs for the browser-extension pairing API."""

from __future__ import annotations

from pydantic import BaseModel


class WebSocketUrlDto(BaseModel):
    """One address the extension popup can be pointed at."""

    label: str
    url: str
    note: str


class PairingResponse(BaseModel):
    """A fresh pairing code for the Chrome extension."""

    code: str
    expires_at: str
    ttl_seconds: int
    websocket_endpoint: str
    websocket_urls: list[WebSocketUrlDto] = []


class BrowserPeerDto(BaseModel):
    """One currently connected browser extension."""

    browser_id: str
    name: str
    connected_at: str
    busy: bool = False


class BrowserStatusResponse(BaseModel):
    """State of the browser-extension bridge."""

    enabled: bool
    agent_mode: bool
    pairing: bool
    paired: list[BrowserPeerDto]
    websocket_endpoint: str
    websocket_urls: list[WebSocketUrlDto] = []


__all__ = [
    "BrowserPeerDto",
    "BrowserStatusResponse",
    "PairingResponse",
    "WebSocketUrlDto",
]
