"""Storage accounting checks using real filesystem fixtures."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "collector.py"
SPEC = importlib.util.spec_from_file_location("forgejo_storage", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "data"
        self.config = self.root / "gitea/conf/app.ini"
        self.config.parent.mkdir(parents=True)
        self.config.write_text(
            f"[server]\nAPP_DATA_PATH={self.root}/gitea\n"
            f"[repository]\nROOT={self.root}/git/repositories\n"
            f"[lfs]\nPATH={self.root}/git/lfs\n"
            f"[database]\nDB_TYPE=sqlite3\nPATH={self.root}/gitea/forgejo.db\n"
            "PASSWD=must-never-appear\n"
        )

    def write(self, relative, size=8192):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"a" * size)
        return target

    def test_breakdown_matches_du_and_ranks_repositories(self):
        self.write("git/repositories/alice/small.git/objects/blob", 8192)
        self.write("git/repositories/bob/large.git/objects/blob", 32768)
        self.write("git/lfs/object", 8192)
        self.write("gitea/forgejo.db", 16384)
        self.write("gitea/forgejo.db-wal", 8192)
        self.write("gitea/attachments/file", 8192)
        self.write("gitea/packages/file", 8192)
        self.write("gitea/repo-archive/cache", 8192)
        self.write("gitea/log/server.log", 8192)
        self.write("gitea/actions_artifacts/artifact", 8192)
        self.write("gitea/actions_log/log", 8192)
        report = collector.collect(self.root, self.config)
        du = subprocess.check_output(["du", "-s", "-B1", str(self.root)], text=True)
        self.assertEqual(report["data_bytes"], int(du.split()[0]))
        categories = collector.storage_paths(self.root, self.config)
        self.assertEqual(report["data_bytes"], sum(report[key + "_bytes"] for key in [*categories, "other"]))
        self.assertEqual(report["repository_count"], 2)
        self.assertEqual([repo["name"] for repo in report["largest_repositories"]], ["bob/large", "alice/small"])
        for category in categories:
            self.assertGreater(report[category + "_bytes"], 0)
        self.assertNotIn("must-never-appear", json.dumps(report))

    def test_sparse_hardlinked_and_external_symlink_files(self):
        target = self.write("git/repositories/alice/repo.git/objects/sparse", 4096)
        with target.open("ab") as handle:
            handle.truncate(64 * 1024 * 1024)
        os.link(target, target.with_name("duplicate"))
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (outside / "large").write_bytes(b"x" * 1024 * 1024)
        (target.parent / "external").symlink_to(outside, target_is_directory=True)
        report = collector.collect(self.root, self.config)
        self.assertLess(report["data_bytes"], 1024 * 1024)
        self.assertEqual(report["repository_count"], 1)
        du = subprocess.check_output(["du", "-s", "-B1", str(self.root)], text=True)
        self.assertEqual(report["data_bytes"], int(du.split()[0]))

    def test_custom_and_nested_paths_are_classified_once(self):
        self.config.write_text(
            f"[server]\nAPP_DATA_PATH={self.root}/gitea\n"
            f"[repository]\nROOT={self.root}/repos\n"
            f"[storage]\nPATH={self.root}/objects\n"
            "[lfs]\nPATH=%(APP_DATA_PATH)s/lfs\n"
            f"[attachment]\nPATH={self.root}/repos/attachments\n"
        )
        self.write("repos/user/repo.git/objects/blob")
        self.write("repos/attachments/photo")
        self.write("objects/packages/package")
        self.write("gitea/lfs/blob")
        report = collector.collect(self.root, self.config)
        self.assertGreater(report["attachments_bytes"], 0)
        self.assertGreater(report["packages_bytes"], 0)
        self.assertGreater(report["lfs_bytes"], 0)
        self.assertEqual(report["repository_count"], 1)
        self.assertEqual(report["data_bytes"], sum(report[name + "_bytes"] for name in [*collector.storage_paths(self.root, self.config), "other"]))

    def test_unmeasurable_storage_is_an_error_not_zero(self):
        for settings in ("[storage]\nSTORAGE_TYPE=minio\n", "[repository]\nROOT=/outside/data\n"):
            self.config.write_text(settings)
            with self.assertRaises(collector.CollectionError):
                collector.collect(self.root, self.config)
        self.config.write_text("[repository\nSECRET=must-never-appear\n")
        with self.assertRaises(collector.CollectionError) as caught:
            collector.collect(self.root, self.config)
        self.assertNotIn("must-never-appear", str(caught.exception))

    def test_private_atomic_report_and_error_exit(self):
        destination = Path(self.temporary.name) / "share/forgejo/storage.json"
        collector.publish(collector.collect(self.root, self.config), destination)
        self.assertEqual(json.loads(destination.read_text())["status"], "ok")
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        collector.publish({"status": "error"}, destination)
        self.assertEqual(json.loads(destination.read_text()), {"status": "error"})
        self.assertEqual(list(destination.parent.iterdir()), [destination])
        result = subprocess.run(
            ["python3", str(MODULE_PATH), "--once", "--data-root", str(self.root), "--config", str(self.root / "missing"), "--output", str(destination)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(destination.read_text())["status"], "error")


if __name__ == "__main__":
    unittest.main()
