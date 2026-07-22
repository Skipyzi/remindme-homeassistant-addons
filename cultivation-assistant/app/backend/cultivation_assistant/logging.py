# pyright: reportMissingImports=false
"""Structured logging configuration with mandatory secret redaction."""

import logging
import sys

import structlog
from structlog.typing import EventDict, WrappedLogger

_SENSITIVE_KEYS = {
    "access_token",
    "authorization",
    "cookie",
    "supervisor_token",
    "token",
}


def redact_sensitive_values(
    logger: WrappedLogger,
    method_name: str,
    event_dict: EventDict,
) -> EventDict:
    """Redact known secret fields before an event reaches any renderer."""
    del logger, method_name
    return {
        key: "[REDACTED]" if key.lower() in _SENSITIVE_KEYS else value
        for key, value in event_dict.items()
    }


def configure_logging(log_level: str) -> None:
    """Configure JSON logs suitable for Home Assistant app collection."""
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=log_level.upper(),
        force=True,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            redact_sensitive_values,
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
