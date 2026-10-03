"""Opaque, sortable, collision-resistant identifiers.

The frontend treats task and event ids as opaque strings and never parses them,
so the only hard requirements are uniqueness and stability. These are ULID-style:
a 48-bit millisecond timestamp followed by 80 bits of randomness, Crockford
base32 encoded. That yields lexicographically sortable ids, which keeps SQLite
index scans on the primary key efficient without a secondary sort column.
"""

from __future__ import annotations

import os
import time

# Crockford base32: no I, L, O or U, so ids cannot be misread aloud.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ENCODED_LENGTH = 26
_RANDOM_BYTES = 10


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


def new_ulid() -> str:
    """A 26-character sortable identifier."""
    timestamp = int(time.time() * 1000) & ((1 << 48) - 1)
    randomness = int.from_bytes(os.urandom(_RANDOM_BYTES), "big")
    return f"{_encode(timestamp, 10)}{_encode(randomness, 16)}"


def new_task_id() -> str:
    """Identifier for a task, e.g. ``task_01JDAG8ZQW0000000000000000``."""
    return f"task_{new_ulid()}"


def new_event_id() -> str:
    """Identifier for a task event, e.g. ``evt_01JDAG8ZQW...``.

    Event ids must be stable and unique: the frontend de-duplicates the activity
    feed by id, so a repeated id silently hides an event and a regenerated id
    shows it twice after a reconnect.
    """
    return f"evt_{new_ulid()}"


def is_ulid_like(value: str, prefix: str) -> bool:
    """Cheap shape check used by tests; not a security boundary.

    Ids are generated as ``f"{prefix}_{ulid}"``, so the separator belongs to the
    head. ``prefix`` may be given with or without its trailing underscore.
    """
    head = prefix if prefix.endswith("_") else f"{prefix}_"
    if not value.startswith(head):
        return False
    body = value[len(head) :]
    return len(body) == _ENCODED_LENGTH and all(char in _ALPHABET for char in body)
