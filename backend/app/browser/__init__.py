"""Browser automation: Chromium lifecycle, frame fan-out, and event helpers."""

from __future__ import annotations

from .browser_events import BrowserEventEmitter
from .browser_manager import BrowserManager, BrowserSession, BrowserUnavailable, ElementRef
from .frame_manager import Frame, FrameManager

__all__ = [
    "BrowserEventEmitter",
    "BrowserManager",
    "BrowserSession",
    "BrowserUnavailable",
    "ElementRef",
    "Frame",
    "FrameManager",
]
