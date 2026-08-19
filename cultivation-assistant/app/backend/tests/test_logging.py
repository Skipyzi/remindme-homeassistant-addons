# pyright: reportMissingImports=false
from cultivation_assistant.logging import redact_sensitive_values


def test_structured_logging_redacts_sensitive_fields() -> None:
    event = {
        "event": "request",
        "token": "secret-token",
        "authorization": "Bearer secret-token",
        "plant_name": "Private plant",
    }

    redacted = redact_sensitive_values(None, "info", event)

    assert redacted == {
        "event": "request",
        "token": "[REDACTED]",
        "authorization": "[REDACTED]",
        "plant_name": "Private plant",
    }
