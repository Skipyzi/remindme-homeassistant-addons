"""Shared fixtures for Sunrise Alarm tests."""

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Enable loading custom integrations in every test."""
    assert enable_custom_integrations is None
