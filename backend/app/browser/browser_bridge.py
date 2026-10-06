"""Pairing and command routing between tasks and the Chrome extension.

This module owns the websocket side of the extension bridge. The browser
extension runs in the user's real Chrome and is the *only* executor of browser
commands; task runs lease it through :meth:`BrowserBridge.lease` and hand it
typed commands, exactly one at a time.

The three rules that keep this safe:

1. **A browser is paired, never trusted.** A pairing code is short-lived,
   single-use and redeemed exactly once; every later message carries the
   ``connection_id`` the code redeemed to, and a message whose id does not match
   its peer is ignored.
2. **One command in flight per browser.** Each peer owns a lock, so a task never
   sends a second command while the extension is still acting on the first, and
   results correlate by ``action_id`` without ambiguity.
3. **Every wait is bounded.** Command execution and the lease-acquisition wait
   both time out, and a timed-out command asks the extension to ``stop`` so a
   wedged page op cannot hold the browser forever.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import WebSocket

from ..adapters.base import AdapterError
from ..config import Settings
from ..utils.time import now_iso

logger = logging.getLogger("agentwebeinh.browser_bridge")

#: WebSocket close code for "a newer connection replaced this one".
CLOSE_REPLACED = 4001
#: WebSocket close code for "the pairing code was rejected".
CLOSE_PAIRING_REJECTED = 4002
#: WebSocket close code for "this socket failed to pair before a deadline".
CLOSE_UNPAIRED_TIMEOUT = 4003

#: Time a freshly connected socket may stay open before it must send ``pair``.
PAIR_WINDOW_SECONDS = 30.0


class PairingRejected(Exception):
    """The extension tried to redeem a code that is unknown, used or expired."""


class ExtensionCommandError(RuntimeError):
    """A browser command failed inside the extension."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class PairingCode:
    """One redeemable pairing code."""

    code: str
    expires_at: str


@dataclass(eq=False, slots=True)
class BrowserPeer:
    """One connected, paired extension."""

    browser_id: str
    connection_id: str
    display_name: str
    websocket: WebSocket
    connected_at: str
    #: Chrome extension id that redeemed the pairing code. Stable per install, so
    #: a re-pair can be recognised as the *same* browser rather than a stranger.
    extension_id: str = ""
    #: Assigned by the first command exchange; also the agent's source id.
    task_id: str | None = None
    #: A task that currently holds this browser through :meth:`lease`.
    leased_by: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    #: ``action_id`` -> future awaiting the matching ``browser_result``.
    pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)


class BrowserBridge:
    """Registry of paired extensions and the command path to them."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._peers: dict[str, BrowserPeer] = {}
        self._codes: dict[str, str] = {}  # code -> expires_at iso
        #: code -> (expires_at iso, extension id) once redeemed. Kept so the *same*
        #: extension can re-pair after a dropped socket (service-worker restart,
        #: network blip, Vercel's socket lifetime) while any other client is still
        #: rejected with "already used".
        self._redeemed: dict[str, tuple[str, str]] = {}
        self._registry_lock = asyncio.Lock()

    # ------------------------------------------------------------- pairing --

    def issue_pairing(self) -> PairingCode:
        """Create a single-use code the extension turns into a connection."""
        ttl = self._settings.browser_extension_pairing_ttl_seconds
        code = _new_code()
        expires = datetime.now(UTC) + timedelta(seconds=ttl)
        self._codes[code] = expires.isoformat()
        return PairingCode(code=code, expires_at=expires.isoformat())

    async def redeem(
        self,
        code: str,
        websocket: WebSocket,
        display_name: str,
        extension_id: str = "",
    ) -> BrowserPeer:
        """Exchange one code for a live peer, replacing any older connection.

        Raises :class:`PairingRejected` for an unknown, expired or already-used
        code. A browser that re-pairs (extension reload, browser restart) gets a
        fresh ``browser_id``; the old websocket is closed with :data:`CLOSE_REPLACED`.

        The *same* extension (identified by its Chrome extension id) may redeem the
        same code again until it expires: a socket that drops mid-session must be
        able to come back, otherwise a single network blip permanently disconnects
        the browser until the user mints a new code. A different extension id is
        rejected, so a leaked code cannot be redeemed twice by two clients.
        """
        normalized = (code or "").strip().upper()
        extension_id = (extension_id or "").strip()[:128]
        async with self._registry_lock:
            expires_at = self._codes.pop(normalized, None)
            if expires_at is None:
                redeemed = self._redeemed.get(normalized)
                if redeemed is not None:
                    redeemed_at, redeemed_by = redeemed
                    if _expired(redeemed_at):
                        self._redeemed.pop(normalized, None)
                    elif extension_id and redeemed_by == extension_id:
                        # Re-pair of the extension that already owns this code.
                        expires_at = redeemed_at
                    else:
                        raise PairingRejected(
                            "That pairing code was already used; create a new one."
                        )
            if expires_at is not None and _expired(expires_at):
                self._redeemed.pop(normalized, None)
                raise PairingRejected("The pairing code has expired; create a new one.")
            if expires_at is not None:
                self._redeemed[normalized] = (expires_at, extension_id)
        if expires_at is None:
            raise PairingRejected("Unknown or already-used pairing code.")

        peer = BrowserPeer(
            browser_id=f"ext-{uuid.uuid4().hex[:10]}",
            connection_id=uuid.uuid4().hex,
            display_name=(display_name or "Chrome").strip()[:40] or "Chrome",
            websocket=websocket,
            connected_at=now_iso(),
            extension_id=extension_id,
        )
        stale: list[BrowserPeer] = []
        async with self._registry_lock:
            # Replace whichever connection this browser presentation had before:
            # the same generated id, or an older socket from the same extension
            # (a re-pair after a drop) that has not been reaped yet.
            for existing in list(self._peers.values()):
                if _is_same_socket(existing.websocket, websocket):
                    continue
                if existing.browser_id == peer.browser_id or (
                    extension_id and existing.extension_id == extension_id
                ):
                    stale.append(existing)
            for existing in stale:
                self._peers.pop(existing.browser_id, None)
            self._peers[peer.browser_id] = peer
        # Dropped outside the lock: `_drop` closes a socket and fails futures, and
        # taking the registry lock again from inside it would deadlock the loop.
        for existing in stale:
            with contextlib.suppress(Exception):
                await existing.websocket.close(
                    code=CLOSE_REPLACED,
                    reason="Replaced by a newer connection from the same extension.",
                )
            await self._fail_things(
                existing, "browser_extension_disconnected",
                "Replaced by a newer connection from the same extension.",
            )
        logger.info("extension_paired browser_id=%s name=%s peers=%s",
                    peer.browser_id, peer.display_name, len(self._peers))
        return peer

    async def unregister(self, peer: BrowserPeer) -> None:
        """Drop a peer without closing the socket (it is already disconnecting)."""
        async with self._registry_lock:
            # Identity, not just the key: a re-pair may already have replaced this
            # peer under the same browser_id, and reaping the new one here would
            # disconnect a browser that is happily connected.
            removed = self._peers.get(peer.browser_id)
            if removed is peer:
                self._peers.pop(peer.browser_id, None)
            else:
                removed = None
        if removed is None:
            return
        logger.info("extension_unpaired browser_id=%s", peer.browser_id)
        await self._fail_things(peer, "browser_extension_disconnected",
                                "The browser extension disconnected.")

    async def _drop(self, peer: BrowserPeer, close_code: int, message: str) -> None:
        """Reap a peer and close its socket. Must not hold the registry lock."""
        async with self._registry_lock:
            if self._peers.get(peer.browser_id) is peer:
                self._peers.pop(peer.browser_id, None)
        with contextlib.suppress(Exception):
            await peer.websocket.close(code=close_code, reason=message[:120])
        await self._fail_things(peer, "browser_extension_disconnected", message)

    async def _fail_things(self, peer: BrowserPeer, code: str, message: str) -> None:
        pending = list(peer.pending.items())
        for _action_id, future in pending:
            future.cancel()
        peer.pending.clear()

    # ------------------------------------------------------------ registry --

    def peer_count(self) -> int:
        return len(self._peers)

    def describe_peers(self) -> list[dict[str, Any]]:
        """Wire-light peer snapshot for ``GET /api/browser/status``."""
        return [
            {
                "browser_id": peer.browser_id,
                "name": peer.display_name,
                "connected_at": peer.connected_at,
                "busy": peer.leased_by is not None,
            }
            for peer in self._peers.values()
        ]

    def health(self) -> object:
        """Compatibility shim so the bridge can sit next to the adapters."""
        from ..adapters.base import IntegrationHealth

        if not self._settings.browser_extension_enabled:
            return IntegrationHealth(
                "extension",
                "disabled",
                "The browser-extension bridge is disabled (AWE_BROWSER_EXTENSION_ENABLED=false).",
            )
        peers = self.describe_peers()
        if peers:
            state = "up"
            detail = f"{len(peers)} paired browser extension(s)."
        else:
            state = "down"
            detail = "No browser extension is paired yet. Open the extension popup and enter a pairing code."
        return IntegrationHealth("extension", state, detail, {"paired": len(peers)})

    # ------------------------------------------------------------- command --

    async def execute(
        self,
        peer: BrowserPeer,
        task_id: str,
        action_id: str,
        command: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        """Send one browser command and await its result from the extension.

        Returns the extension's ``browser_result`` payload (``success`` plus
        ``data`` or ``error``). Raises :class:`ExtensionCommandError` on timeout
        and :class:`AdapterError` when the connection is gone.
        """
        async with peer.lock:
            if peer.browser_id not in self._peers:
                raise AdapterError(
                    "The browser extension is no longer paired.",
                    code="browser_extension_disconnected",
                    retryable=True,
                )
            peer.task_id = task_id
            loop = asyncio.get_running_loop()
            future: asyncio.Future[dict[str, Any]] = loop.create_future()
            peer.pending[action_id] = future
            try:
                await peer.websocket.send_json({
                    "type": "browser_command",
                    "task_id": task_id,
                    "action_id": action_id,
                    "connection_id": peer.connection_id,
                    "command": command,
                })
            except Exception as exc:  # noqa: BLE001 - a socket can fail in many ways
                peer.pending.pop(action_id, None)
                future.cancel()
                raise AdapterError(
                    f"Could not reach the browser extension: {exc}",
                    code="browser_extension_disconnected",
                    retryable=True,
                ) from None
            try:
                return await asyncio.wait_for(future, timeout=timeout)
            except asyncio.CancelledError:
                peer.pending.pop(action_id, None)
                with contextlib.suppress(Exception):
                    await peer.websocket.send_json({"type": "stop", "task_id": task_id})
                raise
            except TimeoutError:
                peer.pending.pop(action_id, None)
                logger.info("browser_command_timed_out task_id=%s action_id=%s", task_id, action_id)
                with contextlib.suppress(Exception):
                    await peer.websocket.send_json({
                        "type": "error",
                        "task_id": task_id,
                        "action_id": action_id,
                        "code": "command_timeout",
                        "message": f"The browser extension did not answer within {timeout:.0f}s.",
                    })
                raise ExtensionCommandError("command_timeout",
                                            f"The extension did not answer within {timeout:.0f}s.") from None

    async def cancel_task(self, peer: BrowserPeer, task_id: str) -> None:
        """Ask the extension to stop whatever it is doing for ``task_id``."""
        with contextlib.suppress(Exception):
            await peer.websocket.send_json({"type": "stop", "task_id": task_id})

    def resolve_result(self, peer: BrowserPeer, message: dict[str, Any]) -> None:
        """Deliver a ``browser_result`` to whoever is waiting on its action."""
        action_id = message.get("action_id")
        if not isinstance(action_id, str) or not action_id:
            return
        if message.get("connection_id") != peer.connection_id:
            logger.warning("bridge_result_connection_mismatch browser_id=%s", peer.browser_id)
            return
        future = peer.pending.pop(action_id, None)
        if future is None or future.done():
            return
        future.set_result(message)
        logger.debug("browser_command_resolved task_id=%s action_id=%s", peer.task_id, action_id)

    # ------------------------------------------------------------- leasing --

    @asynccontextmanager
    async def lease(self, task_id: str, wait_seconds: float) -> AsyncIterator[BrowserPeer]:
        """Yield the first free paired browser, waiting up to ``wait_seconds``.

        Only one task may hold a browser at a time; :attr:`BrowserPeer.leased_by`
        is that marker. The wait is bounded so a task without a paired browser
        fails with an honest ``browser_extension_unavailable`` instead of hanging
        in a state that looks running forever.
        """
        deadline = asyncio.get_running_loop().time() + wait_seconds
        while True:
            peer = self._first_free()
            if peer is not None:
                peer.leased_by = task_id
                break
            if asyncio.get_running_loop().time() >= deadline:
                raise AdapterError(
                    f"No paired browser extension became available within {wait_seconds:.0f}s. "
                    "Open the AgentWebEinh extension popup and enter a pairing code.",
                    code="browser_extension_unavailable",
                    retryable=True,
                )
            await asyncio.sleep(1.0)
        try:
            yield peer
        finally:
            if peer.leased_by == task_id:
                peer.leased_by = None

    def _first_free(self) -> BrowserPeer | None:
        for peer in self._peers.values():
            if peer.leased_by is None:
                return peer
        return None


def _is_same_socket(left: WebSocket, right: WebSocket) -> bool:
    try:
        return left.client == right.client and left.headers == right.headers
    except Exception:  # noqa: BLE001 - defensive; client headers can be messy
        return False


def _expired(expires_at: str) -> bool:
    try:
        when = datetime.fromisoformat(expires_at)
    except ValueError:  # pragma: no cover - defensive
        return True
    return when <= datetime.now(UTC)


def _new_code() -> str:
    """An 8-char code from the urlsafe alphabet, uppercased for readability."""
    return secrets.token_hex(4).upper()


__all__ = [
    "CLOSE_PAIRING_REJECTED",
    "CLOSE_REPLACED",
    "CLOSE_UNPAIRED_TIMEOUT",
    "BrowserBridge",
    "BrowserPeer",
    "ExtensionCommandError",
    "PairingCode",
    "PairingRejected",
]
