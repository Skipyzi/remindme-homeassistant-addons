"""Application configuration loaded from environment variables."""

from pathlib import Path
from typing import Self

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated runtime settings for the app container and local development."""

    model_config = SettingsConfigDict(
        env_prefix="CULTIVATION_",
        env_file=".env",
        extra="ignore",
    )

    data_dir: Path = Path("/data")
    database_url: str = ""
    supervisor_url: str = "http://supervisor/core"
    supervisor_websocket_url: str = "ws://supervisor/core/websocket"
    supervisor_token: SecretStr | None = None
    log_level: str = "INFO"
    frontend_dist: Path = Path("/app/frontend")

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: object) -> object:
        """Keep logging usable when a runtime configuration source returns blank."""
        if isinstance(value, str):
            normalized = value.strip().upper()
            return normalized or "INFO"
        return value

    @model_validator(mode="after")
    def derive_database_url(self) -> Self:
        """Derive the SQLite URL from persistent storage when not explicitly set."""
        if not self.database_url:
            database_path = (self.data_dir / "cultivation.db").as_posix()
            self.database_url = f"sqlite+aiosqlite:///{database_path}"
        return self
