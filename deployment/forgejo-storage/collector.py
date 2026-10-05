#!/usr/bin/env python3
"""Read-only Forgejo allocated disk usage, exported to Home Assistant's share."""

import argparse
import configparser
import json
import logging
import os
from pathlib import Path
import shutil
import signal
import stat
import tempfile
import threading
from datetime import datetime, timezone


class CollectionError(Exception):
    """A complete local storage report cannot be produced."""


def storage_paths(root, config):
    """Read path settings only. Never export configuration or credentials."""
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read_string("[DEFAULT]\n" + config.read_text())
    except (OSError, configparser.Error) as exc:
        raise CollectionError("Forgejo configuration is unavailable or invalid") from exc

    def setting(section, key, default):
        value = parser.get(section, key, fallback=default).strip().strip('"')
        return value

    app = setting("server", "APP_DATA_PATH", str(root / "gitea"))

    def path(value):
        value = value.replace("%(APP_DATA_PATH)s", app)
        candidate = Path(value)
        if not candidate.is_absolute():
            raise CollectionError("Relative storage paths need an explicit absolute path")
        candidate = candidate.resolve()
        if candidate != root and root not in candidate.parents:
            raise CollectionError("Storage outside the add-on data directory is unsupported")
        return candidate

    storage = setting("storage", "PATH", app)
    global_type = setting("storage", "STORAGE_TYPE", "local")
    paths = {
        "repositories": [path(setting("repository", "ROOT", str(root / "git/repositories")))],
        "logs": [path(setting("log", "ROOT_PATH", app + "/log"))],
    }
    subsystems = {
        "lfs": ("lfs", "lfs"),
        "attachments": ("attachment", "attachments"),
        "packages": ("packages", "packages"),
        "archives": ("repo-archive", "repo-archive"),
        "actions": ("actions.artifacts", "actions_artifacts"),
        "actions_logs": ("storage.actions_log", "actions_log"),
    }
    for category, (section, directory) in subsystems.items():
        if setting(section, "STORAGE_TYPE", global_type) != "local":
            raise CollectionError("Remote object storage cannot be measured as local disk usage")
        fallback = storage + "/" + directory
        if section == "lfs":
            fallback = setting("server", "LFS_CONTENT_PATH", fallback)
        paths[category] = [path(setting(section, "PATH", fallback))]

    db_type = setting("database", "DB_TYPE", "sqlite3")
    paths["database"] = []
    if db_type == "sqlite3":
        db = path(setting("database", "PATH", app + "/gitea.db"))
        paths["database"] = [db, Path(str(db) + "-wal"), Path(str(db) + "-shm")]
    return paths


def collect(root, config):
    """Count allocated blocks once per inode, without following symlinks."""
    root = Path(root).resolve()
    if not root.is_dir():
        raise CollectionError("The add-on data directory is unavailable")
    paths = storage_paths(root, Path(config))
    boundaries = [(p, category) for category, items in paths.items() for p in items]
    boundaries.sort(key=lambda item: len(item[0].parts), reverse=True)
    totals = dict.fromkeys(paths, 0)
    totals["other"] = 0
    repository_root = paths["repositories"][0]
    repositories = {}
    seen = set()
    data_bytes = 0

    def visit(directory):
        nonlocal data_bytes
        # Sorting makes attribution of hardlinks stable between scans.
        with os.scandir(directory) as iterator:
            entries = sorted(iterator, key=lambda entry: entry.name)
        for entry in entries:
            item = Path(entry.path)
            try:
                info = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue  # Files may vanish during a concurrent push or log rotation.
            is_directory = stat.S_ISDIR(info.st_mode)
            repo_name = None
            if repository_root in item.parents:
                relative = item.relative_to(repository_root).parts
                if len(relative) >= 2 and relative[1].endswith(".git"):
                    repo_name = "/".join(relative[:2])[:-4]
                    if len(relative) == 2 and is_directory:
                        repositories.setdefault(repo_name, 0)
            inode = (info.st_dev, info.st_ino)
            if inode not in seen:
                seen.add(inode)
                allocated = info.st_blocks * 512
                data_bytes += allocated
                category = "other"
                for boundary, name in boundaries:
                    if item == boundary or boundary in item.parents:
                        category = name
                        break
                totals[category] += allocated
                if repo_name and category == "repositories":
                    repositories[repo_name] = repositories.get(repo_name, 0) + allocated
            if is_directory:
                try:
                    visit(item)
                except FileNotFoundError:
                    continue

    try:
        root_info = root.stat()
        seen.add((root_info.st_dev, root_info.st_ino))
        data_bytes = root_info.st_blocks * 512
        totals["other"] = data_bytes
        visit(root)
        disk = shutil.disk_usage(root)
    except OSError as exc:
        raise CollectionError("Unable to read all local storage") from exc
    return {
        "schema_version": 1,
        "status": "ok",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "data_bytes": data_bytes,
        **{name + "_bytes": size for name, size in totals.items()},
        "repository_count": len(repositories),
        "largest_repositories": [
            {"name": name, "bytes": size}
            for name, size in sorted(repositories.items(), key=lambda item: (-item[1], item[0]))[:10]
        ],
        "filesystem": {
            "total_bytes": disk.total,
            "used_bytes": disk.used,
            "free_bytes": disk.free,
            "used_percent": round(disk.used / disk.total * 100, 1),
        },
        "measurement": "allocated bytes; each inode counted once; symlinks not followed",
    }


def publish(report, output):
    """Replace the report atomically, keeping private repository names private."""
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    descriptor, temporary = tempfile.mkstemp(prefix=".storage-", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(report, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default="/data")
    parser.add_argument("--config", default="/data/gitea/conf/app.ini")
    parser.add_argument("--output", default="/share/forgejo/storage.json")
    parser.add_argument("--interval", type=int, default=600)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.interval < 60:
        parser.error("interval must be at least 60 seconds")
    logging.basicConfig(level=logging.INFO, format="forgejo-storage: %(message)s")
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    while not stopped.is_set():
        try:
            report = collect(args.data_root, args.config)
        except CollectionError as exc:
            # Only our fixed messages are safe to log; parser exceptions may contain secrets.
            logging.warning("%s", exc)
            report = {"status": "error", "collected_at": datetime.now(timezone.utc).isoformat()}
        try:
            publish(report, args.output)
        except OSError:
            logging.error("Unable to write the storage report")
            if args.once:
                return 1
        if args.once:
            return 0 if report["status"] == "ok" else 1
        stopped.wait(args.interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
