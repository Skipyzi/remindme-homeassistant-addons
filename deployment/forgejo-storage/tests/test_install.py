"""Check config merging fails safely and repeated installs preserve the version."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("forgejo_install", Path(__file__).resolve().parents[1] / "install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.addon = Path(self.temporary.name) / "addon"
        self.ha = Path(self.temporary.name) / "config"
        self.addon.mkdir()
        self.ha.mkdir()
        (self.addon / "Dockerfile").write_text("FROM forgejo:16.0.5\nRUN apk add --no-cache jq\nCOPY run.sh /run.sh\n")
        (self.addon / "run.sh").write_text('#!/bin/sh\nexec /usr/bin/entrypoint "$@"\n')
        (self.addon / "config.yaml").write_text('version: "1.6.0"\nmap:\n  - type: data\n    path: /data\n    read_only: false\noptions:\n  registration_enabled: false\n')
        (self.ha / "configuration.yaml").write_text("default_config:\n")

    def test_install_is_idempotent_and_keeps_existing_settings(self):
        installer.install(self.addon, self.ha)
        first_config = (self.addon / "config.yaml").read_text()
        first_ha = (self.ha / "configuration.yaml").read_text()
        self.assertIn('version: "1.6.1"', first_config)
        self.assertIn("registration_enabled: false", first_config)
        self.assertEqual(first_config.count("type: share"), 1)
        self.assertTrue((self.addon / "storage/collector.py").exists())
        self.assertTrue(first_ha.startswith("default_config:\n"))
        self.assertIn("require_admin: true", first_ha)
        installer.install(self.addon, self.ha)
        self.assertEqual((self.addon / "config.yaml").read_text(), first_config)
        self.assertEqual((self.ha / "configuration.yaml").read_text(), first_ha)
        self.assertEqual((self.addon / "run.sh").read_text().count("python3"), 1)

    def test_existing_root_configuration_stops_before_any_changes(self):
        (self.ha / "configuration.yaml").write_text("homeassistant:\n  name: My home\n")
        before = (self.addon / "Dockerfile").read_text()
        with self.assertRaises(SystemExit):
            installer.install(self.addon, self.ha)
        self.assertEqual((self.addon / "Dockerfile").read_text(), before)
        self.assertFalse((self.addon / "storage").exists())


if __name__ == "__main__":
    unittest.main()
