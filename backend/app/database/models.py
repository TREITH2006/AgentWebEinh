"""SQLAlchemy table definitions.

Timestamps are stored as **TEXT** in a fixed-width ISO-8601 UTC format rather
than as a DATETIME column. SQLite has no native timezone type, and fixed-width
ISO strings sort lexicographically in chronological order, so range filters and
``ORDER BY`` stay correct without any date parsing in SQL. ``utils/time.py``
guarantees the width.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

#: Width of a fixed-width ISO-8601 UTC string, e.g. ``2026-01-14T09:12:04.123456Z``.
ISO_WIDTH = 27


class Base(DeclarativeBase):
    """Declarative base for every table."""


class TaskRow(Base):
    """One submitted task and everything currently known about it.

    ``report_json`` holds the serialised :class:`~app.schemas.report.TaskReportDto`.
    It is written **before** the terminal status is published, because the
    frontend re-reads the task the instant it sees a terminal snapshot and would
    otherwise render "no report returned".
    """

    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    created_at: Mapped[str] = mapped_column(String(ISO_WIDTH), nullable=False)
    started_at: Mapped[str | None] = mapped_column(String(ISO_WIDTH), nullable=True)
    completed_at: Mapped[str | None] = mapped_column(String(ISO_WIDTH), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    progress: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_activity: Mapped[str | None] = mapped_column(String(512), nullable=True)
    current_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    current_title: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_retryable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    report_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Idempotency key supplied by the client. Unique so a retried submit cannot
    #: start a second run; ``None`` for requests that did not send one.
    client_request_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True
    )

    #: Which browser engine ran the task, for diagnostics.
    engine: Mapped[str | None] = mapped_column(String(32), nullable=True)
    frames_captured: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_frame_at: Mapped[str | None] = mapped_column(String(ISO_WIDTH), nullable=True)

    __table_args__ = (
        Index("ix_tasks_created_at", "created_at"),
        Index("ix_tasks_status_created", "status", "created_at"),
        Index("ix_tasks_completed_at", "completed_at"),
    )


class EventRow(Base):
    """One immutable entry in a task's activity history.

    ``seq`` is per-task, contiguous and gap-free from 1. The frontend compares
    each streamed ``seq`` against the previous one and re-reads the task when it
    finds a hole, so ``seq`` must never be reused or skipped within a task.
    """

    __tablename__ = "task_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    at: Mapped[str] = mapped_column(String(ISO_WIDTH), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    data_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint("task_id", "seq", name="uq_task_events_task_seq"),
        Index("ix_task_events_task_seq", "task_id", "seq"),
    )
