from datetime import UTC, datetime

import httpx
from cultivation_assistant.home_assistant.client import HomeAssistantClient
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.runtime import RuntimeStatus
from pydantic import SecretStr


async def test_client_validates_authentication_and_loads_initial_states() -> None:
    seen_authorization: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers["Authorization"])
        if request.url.path == "/core/api/":
            return httpx.Response(200, json={"message": "API running."})
        if request.url.path == "/core/api/states":
            return httpx.Response(
                200,
                json=[
                    {
                        "entity_id": "sensor.tent_temperature",
                        "state": "25.4",
                        "attributes": {"unit_of_measurement": "°C"},
                        "last_updated": datetime.now(UTC).isoformat(),
                    }
                ],
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://supervisor/core")
    cache = EntityStateCache()
    status = RuntimeStatus()
    client = HomeAssistantClient(
        base_url="http://supervisor/core",
        token=SecretStr("supervisor-secret"),
        state_cache=cache,
        runtime_status=status,
        http_client=http_client,
    )

    await client.validate_authentication()
    loaded = await client.load_initial_states()
    await http_client.aclose()

    assert loaded == 1
    assert status.home_assistant_connected
    assert cache.get("sensor.tent_temperature").state == "25.4"
    assert seen_authorization == ["Bearer supervisor-secret", "Bearer supervisor-secret"]


async def test_script_invocation_uses_home_assistant_service_api() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = request.content.decode("utf-8")
        return httpx.Response(200, json=[])

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://supervisor/core"
    )
    client = HomeAssistantClient(
        base_url="http://supervisor/core",
        token=SecretStr("supervisor-secret"),
        state_cache=EntityStateCache(),
        runtime_status=RuntimeStatus(),
        http_client=http_client,
    )

    await client.invoke_script("script.safe_irrigation", {"duration_seconds": 30})
    await http_client.aclose()

    assert captured == {
        "path": "/core/api/services/script/turn_on",
        "body": ('{"entity_id":"script.safe_irrigation","variables":{"duration_seconds":30}}'),
    }
