#!/usr/bin/env python3
"""Install storage monitoring into the local Forgejo add-on and HA configuration.

Run after backing up both. Supervisor rebuild and HA config check/restart are separate.
Existing HA homeassistant/lovelace configuration needs the manual merge in README.md.
"""

import argparse
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
MARKER = "# Forgejo storage monitoring"


def install(addon, ha):
    docker = (addon / "Dockerfile").read_text()
    run = (addon / "run.sh").read_text()
    config = (addon / "config.yaml").read_text()
    ha_config = (ha / "configuration.yaml").read_text()
    if MARKER not in ha_config:
        for key in ("homeassistant", "lovelace"):
            if re.search(r"^" + key + r":", ha_config, re.MULTILINE):
                raise SystemExit(f"Merge {key} settings manually before installing; see README.md")
        if (ha / "packages").exists() and any((ha / "packages").iterdir()):
            raise SystemExit("Existing packages need review before enabling a directory include")
    if not re.search(r"^\s*- type: share\s*$", config, re.MULTILINE):
        if "\noptions:" not in config:
            raise SystemExit("Expected a map block before options in Forgejo config.yaml")
        config = config.replace("\noptions:", "\n  - type: share\n    read_only: false\noptions:", 1)
    if "COPY storage/ /opt/forgejo-storage/" not in docker:
        if "RUN apk add --no-cache jq" not in docker:
            raise SystemExit("Expected apk jq installation in Forgejo Dockerfile")
        docker = docker.replace("RUN apk add --no-cache jq", "RUN apk add --no-cache jq python3", 1)
        docker = docker.replace("COPY run.sh /run.sh", "COPY storage/ /opt/forgejo-storage/\nCOPY run.sh /run.sh", 1)
    if MARKER not in run:
        entrypoint = 'exec /usr/bin/entrypoint "$@"'
        if entrypoint not in run:
            raise SystemExit("Expected Forgejo entrypoint in run.sh")
        run = run.replace(entrypoint, MARKER + '\npython3 /opt/forgejo-storage/collector.py --config "${GITEA_CUSTOM:-/data/gitea}/conf/app.ini" &\n\n' + entrypoint, 1)
    storage = addon / "storage/collector.py"
    changed = (
        docker != (addon / "Dockerfile").read_text()
        or run != (addon / "run.sh").read_text()
        or config != (addon / "config.yaml").read_text()
        or not storage.exists()
        or storage.read_bytes() != (HERE / "collector.py").read_bytes()
    )
    if changed:
        version = re.search(r'^version: "(\d+)\.(\d+)\.(\d+)"$', config, re.MULTILINE)
        if not version:
            raise SystemExit("Expected quoted semantic add-on version")
        major, minor, patch = map(int, version.groups())
        config = config[:version.start()] + f'version: "{major}.{minor}.{patch + 1}"' + config[version.end():]
    # All preflight checks completed before writing.
    (addon / "Dockerfile").write_text(docker)
    (addon / "run.sh").write_text(run)
    (addon / "config.yaml").write_text(config)
    storage.parent.mkdir(exist_ok=True)
    shutil.copyfile(HERE / "collector.py", storage)
    (ha / "packages").mkdir(exist_ok=True)
    (ha / "dashboards").mkdir(exist_ok=True)
    shutil.copyfile(HERE / "homeassistant-package.yaml", ha / "packages/forgejo_storage.yaml")
    shutil.copyfile(HERE / "dashboard.yaml", ha / "dashboards/version-control.yaml")
    if MARKER not in ha_config:
        ha_config += "\n" + MARKER + "\n" + """homeassistant:
  packages: !include_dir_named packages

lovelace:
  dashboards:
    version-control:
      mode: yaml
      title: Version control
      icon: mdi:source-repository
      show_in_sidebar: true
      require_admin: true
      filename: dashboards/version-control.yaml
"""
        (ha / "configuration.yaml").write_text(ha_config)
    print("Storage monitor installed. Reload the add-on store and update Forgejo, then check and restart Home Assistant.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon", type=Path, default=Path("/addons/forgejo"))
    parser.add_argument("--homeassistant", type=Path, default=Path("/config"))
    args = parser.parse_args()
    install(args.addon, args.homeassistant)
