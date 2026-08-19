from pathlib import Path

import yaml


def test_home_assistant_app_is_ingress_only_and_uses_internal_api() -> None:
    config_path = Path("cultivation/config.yaml")
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    assert config["ingress"]
    assert config["ingress_port"] == 8099
    assert config["homeassistant_api"]
    assert config["ports"]["8099/tcp"] is None


def test_build_from_argument_is_available_to_every_docker_stage() -> None:
    lines = Path("cultivation/Dockerfile").read_text(encoding="utf-8").splitlines()
    build_arg_index = lines.index(
        "ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12-alpine3.21"
    )
    first_stage_index = next(index for index, line in enumerate(lines) if line.startswith("FROM "))

    assert build_arg_index < first_stage_index


def test_published_app_targets_the_addon_repository() -> None:
    config = yaml.safe_load(Path("cultivation/config.yaml").read_text(encoding="utf-8"))
    build = yaml.safe_load(Path("cultivation/build.yaml").read_text(encoding="utf-8"))
    dockerfile = Path("cultivation/Dockerfile").read_text(encoding="utf-8")
    repository_url = "https://github.com/Skipyzi/remindme-homeassistant-addons"

    assert config["url"] == repository_url
    assert build["labels"]["org.opencontainers.image.source"] == repository_url
    assert "RUN chmod +x" in dockerfile
    assert "/etc/services.d/cultivation/run" in dockerfile
    assert "/etc/services.d/cultivation/finish" in dockerfile


def test_app_build_context_contains_runtime_sources() -> None:
    required = {
        Path("cultivation/app/backend/cultivation_assistant/main.py"),
        Path("cultivation/app/backend/alembic/versions/0001_foundation.py"),
        Path("cultivation/app/backend/alembic/versions/0002_grow_spaces.py"),
        Path("cultivation/app/backend/alembic/versions/0003_grow_space_dimensions.py"),
        Path("cultivation/app/backend/alembic/versions/0004_grows_plants_lifecycle.py"),
        Path("cultivation/app/backend/alembic/versions/0005_journal_photos_measurements.py"),
        Path("cultivation/app/backend/cultivation_assistant/plants/router.py"),
        Path("cultivation/app/backend/cultivation_assistant/journal/router.py"),
        Path("cultivation/app/backend/cultivation_assistant/grow_spaces/router.py"),
        Path("cultivation/app/backend/cultivation_assistant/grow_spaces/dimensions.py"),
        Path("cultivation/app/frontend/src/api/growSpaces.ts"),
        Path("cultivation/app/frontend/src/features/grow-spaces/GrowSpaceDetailsForm.tsx"),
        Path("cultivation/app/frontend/package.json"),
        Path("cultivation/app/pyproject.toml"),
        Path("cultivation/rootfs/etc/services.d/cultivation/run"),
    }

    assert all(path.is_file() for path in required)
