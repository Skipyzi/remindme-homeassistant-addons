# pyright: reportMissingImports=false
from pathlib import Path

from cultivation_assistant.config import Settings
from pydantic import SecretStr


def test_settings_use_local_persistent_data_directory() -> None:
    settings = Settings()

    assert settings.data_dir == Path("/data")
    assert settings.database_url == "sqlite+aiosqlite:////data/cultivation.db"


def test_blank_runtime_log_level_falls_back_to_info() -> None:
    settings = Settings(log_level="  ")

    assert settings.log_level == "INFO"


def test_supervisor_token_is_redacted_from_settings_representation() -> None:
    settings = Settings(supervisor_token=SecretStr("top-secret"))

    assert "top-secret" not in repr(settings)
