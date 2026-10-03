"""UTC time helpers.

Every timestamp that crosses a layer boundary is a **fixed-width** ISO-8601 UTC
string (``2026-01-14T09:12:04.123456Z``).

Fixed width matters: task rows store timestamps as TEXT, and statistics group and
range-filter on those strings. With a constant width, lexicographic ordering is
identical to chronological ordering, so plain SQL ``ORDER BY`` / ``BETWEEN`` are
correct without any date parsing in the database layer.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

# Constant width: always 6 fractional digits and a literal ``Z``.
ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
DAY_FORMAT = "%Y-%m-%d"

UTC = UTC


def utc_now() -> datetime:
    """Current time as an aware UTC datetime."""
    return datetime.now(UTC)


def to_iso(value: datetime | None) -> str | None:
    """Render an aware/naive datetime as a fixed-width UTC ISO string."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime(ISO_FORMAT)


def now_iso() -> str:
    """Current time as a fixed-width UTC ISO string."""
    return to_iso(utc_now())  # type: ignore[return-value]


def parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO string produced by :func:`to_iso` (or by a client).

    Returns an aware UTC datetime, or ``None`` when the input is missing or
    unparseable. Callers treat ``None`` as "the backend did not report this".
    """
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith(("Z", "z")):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def day_key(value: datetime | str | None) -> str | None:
    """UTC calendar day of a timestamp as ``YYYY-MM-DD``."""
    if value is None:
        return None
    if isinstance(value, str):
        parsed = parse_iso(value)
        if parsed is None:
            # Tolerate a bare date such as ``2026-01-14``.
            try:
                return datetime.strptime(value[:10], DAY_FORMAT).strftime(DAY_FORMAT)
            except ValueError:
                return None
        value = parsed
    return value.astimezone(UTC).strftime(DAY_FORMAT)


def today_key() -> str:
    """Today's UTC calendar day."""
    return utc_now().strftime(DAY_FORMAT)


def day_window(days: int) -> tuple[str, str]:
    """Half-open ``[start, end)`` ISO bounds covering the last ``days`` UTC days.

    ``days=7`` means *today plus the previous six calendar days*, which is the
    window the frontend's ``7d`` statistics range expects. The window ends at the
    start of the next UTC day so a task created a moment from now is included.
    """
    if days < 1:
        raise ValueError("days must be >= 1")
    today = utc_now().replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=days - 1)
    end = today + timedelta(days=1)
    return to_iso(start), to_iso(end)  # type: ignore[return-value]


def enumerate_day_keys(days: int) -> list[str]:
    """Every UTC calendar day in the :func:`day_window` range, oldest first.

    Statistics buckets are dense: the frontend charts place points by date, so a
    day with no activity must still be present with zeroed counters.
    """
    today = utc_now().replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=days - 1)
    return [(start + timedelta(days=offset)).strftime(DAY_FORMAT) for offset in range(days)]


def elapsed_ms(start: datetime | str | None, end: datetime | str | None) -> int | None:
    """Milliseconds between two timestamps, or ``None`` if either is missing."""
    started = parse_iso(start) if isinstance(start, str) or start is None else start
    finished = parse_iso(end) if isinstance(end, str) or end is None else end
    if started is None or finished is None:
        return None
    delta = (finished - started).total_seconds() * 1000.0
    return int(delta) if delta >= 0 else None
