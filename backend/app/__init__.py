"""AgentWebEinh backend application package.

Layering (import direction is strictly downward):

    api          HTTP/WebSocket transport only; no business rules
    services     use-case orchestration exposed to the transport layer
    core         task lifecycle, events, state machine, orchestration
    browser      Chromium lifecycle and frame fan-out
    adapters     integrations with external processes/services
    database     persistence
    schemas      wire DTOs (Pydantic) shared by every layer above
    utils        dependency-free helpers
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
