# pyright: reportMissingImports=false
from pathlib import Path

from cultivation_assistant.config import Settings
from cultivation_assistant.home_assistant.client import HomeAssistantClient
from cultivation_assistant.home_assistant.subscription import HomeAssistantEventSubscriber
from cultivation_assistant.main import create_app
from pydantic import SecretStr


def test_app_wires_home_assistant_services_from_supervisor_token(tmp_path: Path) -> None:
    app = create_app(
        settings=Settings(
            data_dir=tmp_path,
            supervisor_token=SecretStr("supervisor-secret"),
        )
    )

    assert isinstance(app.state.home_assistant_client, HomeAssistantClient)
    assert isinstance(app.state.home_assistant_subscriber, HomeAssistantEventSubscriber)
