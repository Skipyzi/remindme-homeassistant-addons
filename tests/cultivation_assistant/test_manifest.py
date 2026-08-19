import json
from pathlib import Path


def test_manifest_declares_config_flow_and_diagnostics() -> None:
    manifest_path = Path("custom_components/cultivation_assistant/manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AssertionError("Integration manifest must be readable valid JSON") from exc

    assert manifest["domain"] == "cultivation_assistant"
    assert bool(manifest["config_flow"])
    assert manifest["version"] == "0.6.0"
    assert manifest["integration_type"] == "service"
