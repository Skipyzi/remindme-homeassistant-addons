"""Mutable process health shared by application services."""

from dataclasses import dataclass


@dataclass(slots=True)
class RuntimeStatus:
    """Current readiness of required local dependencies."""

    database_ready: bool = False
    home_assistant_connected: bool = False
    schema_version: str = "unknown"

    def checks(self) -> dict[str, str]:
        """Return stable public names for readiness checks."""
        return {
            "database": "ready" if self.database_ready else "unavailable",
            "home_assistant": "ready" if self.home_assistant_connected else "unavailable",
        }

    @property
    def ready(self) -> bool:
        """Return whether every required dependency is ready."""
        return self.database_ready and self.home_assistant_connected
