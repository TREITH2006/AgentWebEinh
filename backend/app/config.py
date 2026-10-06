"""Application configuration.

Every setting is read from an environment variable prefixed with ``AWE_``, with
an optional ``backend/.env`` file for local overrides. Nothing here reads global
state, and no credential is ever given a usable default: secrets stay in the
environment and are never logged.

The frontend contract forces two settings to be explicit rather than inferred:

``public_base_url``
    Browser frames are rendered with a plain ``<img>``, and the frontend's
    normalizer rejects any URL that is not an absolute ``http(s)`` URL. The
    backend therefore has to *know* the origin the browser used to reach it.

``database_file``
    Kept inside the project directory. It is validated on startup so a
    misconfigured path cannot point at another project's data.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: ``backend/app/config.py`` -> ``backend/app`` -> ``backend`` -> project root.
BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"

#: Prefix for every environment variable. Named so ``.env.example`` and the test
#: suite can refer to it instead of repeating the literal.
ENV_PREFIX = "AWE_"


class Settings(BaseSettings):
    """Runtime settings for the AgentWebEinh backend."""

    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ------------------------------------------------------------ identity --
    app_name: str = "AgentWebEinh API"
    environment: Literal["development", "production", "test"] = "development"
    host: str = "127.0.0.1"
    port: int = 8000

    #: Absolute origin the browser used to reach this service. Used to build the
    #: absolute ``frames_url`` / ``snapshot_url`` values the frontend requires.
    public_base_url: str = "http://127.0.0.1:8000"

    # ---------------------------------------------------------- persistence --
    database_file: Path = DATA_DIR / "tasks.db"

    # ------------------------------------------------------ task execution --
    max_concurrent_tasks: int = 2
    task_timeout_seconds: int = 1_800
    #: Budget for one model call inside the agent loop. Must exceed the real
    #: latency of the configured local model: ``qwen3-vl:8b`` on CPU takes well
    #: over two minutes to answer one action, so a tighter budget failed every run
    #: with ``model_timeout`` before the model ever spoke. Measured latency on this
    #: machine ranges from ~10s to >300s for the same call, because the length of
    #: the model's ``thinking`` block is unpredictable, so this is set above the
    #: worst case observed rather than the average.
    step_timeout_seconds: int = 420
    max_orchestrator_steps: int = 30
    #: How long a task may wait for the single shared browser before giving up.
    #: Without a bound, a second concurrent task blocked inside the exclusivity
    #: lock looked identical to a hung task: no events, no progress, no timeout.
    browser_session_wait_seconds: int = 600
    #: How long ``GET /api/status`` may reuse the previous integration probe
    #: before re-running it.
    #:
    #: The OpenClaw health probe shells out to a Node CLI that needs ~5.5s to
    #: start on Windows, so probing on every request made ``/api/status`` take
    #: longer than the frontend's identity-probe deadline and the UI reported a
    #: healthy backend as unreachable. Caching keeps the response fast while the
    #: reported component states stay real, just a few seconds old.
    status_cache_seconds: float = 15.0
    prompt_min_length: int = 1
    prompt_max_length: int = 2000
    history_default_limit: int = 25
    history_max_limit: int = 200
    stream_queue_size: int = 256
    send_snapshot_on_connect: bool = True

    # ------------------------------------------------------------ OpenClaw --
    openclaw_enabled: bool = True
    openclaw_cli: str = "openclaw"
    openclaw_gateway_url: str = "ws://127.0.0.1:18789"
    #: Budget for `openclaw health --json`. This covers the whole CLI process, not
    #: just the gateway probe it performs: the Node CLI needs ~8s to start on this
    #: PC while the probe itself answers in ~20ms, so the previous 4s budget
    #: reported a healthy gateway as "down / exceeded 4s".
    openclaw_health_timeout_ms: int = 20_000
    openclaw_agent_timeout_seconds: int = 180
    #: When true the orchestrator asks OpenClaw to lead the run. When OpenClaw is
    #: unavailable the run continues on the native Playwright + Ollama path.
    openclaw_orchestrates: bool = False
    #: Agent id that owns task sessions. Runs are addressed to
    #: ``agent:<openclaw_agent_id>:<openclaw_session_prefix>-<task_id>`` so a task
    #: never appends to a human's session such as ``agent:main:main``.
    openclaw_agent_id: str = "main"
    openclaw_session_prefix: str = "awe"

    # -------------------------------------------------------------- Ollama --
    ollama_enabled: bool = True
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3-vl:8b"
    ollama_embedding_model: str = "qwen3-embedding:0.6b"
    ollama_health_timeout_seconds: float = 4.0
    ollama_timeout_seconds: float = 480.0
    #: Must comfortably exceed ``ollama_num_predict_floor``: Ollama silently drops
    #: the oldest messages when prompt plus predicted tokens exceed the context
    #: window, which would quietly remove the system prompt and the task.
    ollama_num_ctx: int = 16_384
    ollama_temperature: float = 0.1
    ollama_keep_alive: str = "10m"
    #: Lower bound applied to every ``num_predict`` budget.
    #:
    #: Reasoning models (``qwen3-*``) emit a ``thinking`` block *before* the answer,
    #: and ``num_predict`` caps thinking and content together. A budget sized for the
    #: answer alone is therefore fully consumed by reasoning, Ollama returns
    #: ``done_reason="length"`` with an empty ``content``, and the adapter raises
    #: ``ollama_empty`` — a hard failure that looks like an unreachable model.
    #: Ollama's ``think=false`` does not suppress this for the VL build, so the
    #: floor is the reliable fix. Raise it for models that deliberate at length.
    ollama_num_predict_floor: int = 8_192
    #: Whether the model may spend tokens on a ``thinking`` block before answering.
    #:
    #: Every caller here wants a direct answer: one JSON action, or one report
    #: object. A reasoning model given permission to think will spend the whole
    #: ``num_predict`` budget doing it and return ``done_reason="length"`` with an
    #: empty completion, which surfaced as a hard ``ollama_empty`` failure. Off by
    #: default; set true only for a model/task that genuinely needs it.
    ollama_think: bool = False

    # ------------------------------------------------------------- browser --
    browser_enabled: bool = True
    browser_engine: Literal["native", "browser_use"] = "native"
    browser_headless: bool = True
    browser_navigation_timeout_ms: int = 30_000
    browser_slow_mo_ms: int = 0
    browser_viewport_width: int = 1_440
    browser_viewport_height: int = 900
    browser_frame_interval_ms: int = 1_000
    browser_frame_quality: int = 70
    browser_max_screenshot_bytes: int = 8_000_000
    browser_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 AgentWebEinh/1.0"
    )
    screenshots_dir: Path = DATA_DIR / "screenshots"

    # ------------------------------------------------------- extension --
    #: The paired Chrome extension (Phases 2C/2D). When ``browser_extension_agent``
    #: is true the orchestrator drives the *user's real Chrome* through the
    #: extension instead of the in-process Playwright browser.
    browser_extension_enabled: bool = True
    #: Use the paired extension as the browser engine for every run. On by
    #: default because it *is* the product: tasks drive the user's real Chrome.
    #: Set ``AWE_BROWSER_EXTENSION_AGENT=false`` to fall back to the in-process
    #: Playwright engine (development only).
    browser_extension_agent: bool = True
    #: How long one browser command may await its result from the extension.
    browser_extension_command_timeout_seconds: float = 120.0
    #: How long a task waits for a paired (and free) browser before failing.
    browser_extension_wait_seconds: int = 120
    #: Lifetime of one pairing code; codes are single-use and memory-resident.
    browser_extension_pairing_ttl_seconds: int = 600
    #: Cap on interactive elements returned in one page observation.
    browser_extension_max_elements: int = 60
    #: Optional research helper. Disabled by default: the core product must not
    #: depend on it, and enabling it shells out to the installed CLI.
    tinyfish_enabled: bool = False
    tinyfish_cli: str = "tinyfish"
    tinyfish_timeout_seconds: float = 60.0
    #: Hard ceiling on how many results a research call may return.
    tinyfish_max_results: int = 5

    # -------------------------------------------------- security / logging --
    log_level: str = "INFO"
    log_json: bool = False
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )
    allow_origin_regex: str | None = None

    # ---------------------------------------------------------- validators --

    @field_validator("public_base_url")
    @classmethod
    def _validate_public_base_url(cls, value: str) -> str:
        """Must be an absolute http(s) origin: the frontend rejects anything else."""
        text = (value or "").strip().rstrip("/")
        if not text:
            raise ValueError("AWE_PUBLIC_BASE_URL must not be empty")
        if not text.startswith(("http://", "https://")):
            raise ValueError("AWE_PUBLIC_BASE_URL must start with http:// or https://")
        return text

    @field_validator("database_file", "screenshots_dir")
    @classmethod
    def _validate_project_local_path(cls, value: Path) -> Path:
        """Confine writable paths to this project.

        The backend performs user-directed automation, so a path that escapes the
        project would let a bad environment variable point persistence or
        screenshots at an unrelated directory.

        A relative value is anchored to the *project root* rather than the process
        working directory. Settings values otherwise resolve against whatever
        directory happens to be current, so ``data/tasks.db`` would mean one thing
        when set by default and a different thing in ``.env``, ``AWE_DATABASE_FILE``,
        or a test -- and the same string would silently select a different database
        depending on where the command was run from.
        """
        candidate = Path(value).expanduser()
        resolved = (PROJECT_ROOT / candidate if not candidate.is_absolute() else candidate).resolve()
        root = PROJECT_ROOT.resolve()
        if root != resolved and root not in resolved.parents:
            raise ValueError(f"path must stay inside {root}, got {resolved}")
        return resolved

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        allowed = {"TRACE", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        level = (value or "INFO").strip().upper()
        if level not in allowed:
            raise ValueError(f"log level must be one of {sorted(allowed)}")
        return level

    @model_validator(mode="after")
    def _validate_ranges(self) -> Settings:
        if self.prompt_min_length < 1:
            raise ValueError("AWE_PROMPT_MIN_LENGTH must be >= 1")
        if self.prompt_max_length < self.prompt_min_length:
            raise ValueError("AWE_PROMPT_MAX_LENGTH must be >= AWE_PROMPT_MIN_LENGTH")
        if self.max_concurrent_tasks < 1:
            raise ValueError("AWE_MAX_CONCURRENT_TASKS must be >= 1")
        if self.browser_session_wait_seconds < 1:
            raise ValueError("AWE_BROWSER_SESSION_WAIT_SECONDS must be >= 1")
        if self.step_timeout_seconds < 1:
            raise ValueError("AWE_STEP_TIMEOUT_SECONDS must be >= 1")
        if self.status_cache_seconds < 0:
            raise ValueError("AWE_STATUS_CACHE_SECONDS must be >= 0")
        if not 1 <= self.history_default_limit <= self.history_max_limit:
            raise ValueError("history default limit must be within 1..history_max_limit")
        if self.browser_frame_interval_ms < 200:
            raise ValueError("AWE_BROWSER_FRAME_INTERVAL_MS must be >= 200")
        if not 1 <= self.browser_frame_quality <= 100:
            raise ValueError("AWE_BROWSER_FRAME_QUALITY must be within 1..100")
        if self.browser_extension_command_timeout_seconds < 0.3:
            raise ValueError("AWE_BROWSER_EXTENSION_COMMAND_TIMEOUT_SECONDS must be >= 0.3")
        if self.browser_extension_wait_seconds < 1:
            raise ValueError("AWE_BROWSER_EXTENSION_WAIT_SECONDS must be >= 1")
        if self.browser_extension_pairing_ttl_seconds < 30:
            raise ValueError("AWE_BROWSER_EXTENSION_PAIRING_TTL_SECONDS must be >= 30")
        return self

    # --------------------------------------------------------- derived URLs --

    @property
    def database_url(self) -> str:
        """Async SQLAlchemy URL for the SQLite database."""
        return f"sqlite+aiosqlite:///{self.database_file.as_posix()}"

    @property
    def ollama_url(self) -> str:
        return self.ollama_base_url.rstrip("/")

    @property
    def openclaw_gateway(self) -> str:
        return self.openclaw_gateway_url.rstrip("/")

    def absolute_url(self, path: str) -> str:
        """Join ``path`` onto :attr:`public_base_url`.

        ``path`` must be backend-relative (``/api/tasks/...``), never a full URL,
        so a base-URL change cannot be defeated by a stored absolute value.
        """
        suffix = path if path.startswith("/") else f"/{path}"
        return f"{self.public_base_url}{suffix}"

    def frames_metadata_url(self, task_id: str) -> str:
        """Absolute URL of the frame-discovery endpoint for a task."""
        return self.absolute_url(f"/api/tasks/{task_id}/frames")

    def frames_stream_url(self, task_id: str) -> str:
        """Absolute URL of the long-lived MJPEG stream for a task."""
        return self.absolute_url(f"/api/tasks/{task_id}/stream.mjpeg")

    def snapshot_url(self, task_id: str) -> str:
        """Absolute URL of the latest-JPEG snapshot for a task."""
        return self.absolute_url(f"/api/tasks/{task_id}/frame.jpg")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton.

    Cached so every layer observes the same configuration; tests that need a
    different environment should call :func:`settings_override` instead of
    mutating the cache in place.
    """
    return Settings()


def settings_override(**overrides: object) -> Settings:
    """Build a fresh :class:`Settings` for a test, bypassing the cache."""
    return Settings(**overrides)  # type: ignore[arg-type]
