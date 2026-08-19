# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
# pyright: reportUnknownArgumentType=false
import pytest

from custom_components.cultivation_assistant.api import InvalidAppResponse, parse_health


def test_parse_health_accepts_versioned_app_status() -> None:
    health = parse_health({"status": "healthy", "version": "0.1.0"})

    assert health.status == "healthy"
    assert health.version == "0.1.0"


def test_parse_health_rejects_incomplete_response() -> None:
    with pytest.raises(InvalidAppResponse):
        parse_health({"status": "healthy"})
