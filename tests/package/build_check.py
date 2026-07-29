from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class DistributionTests(unittest.TestCase):
    def test_uv_build_contains_cli_and_clean_workspace_template(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sdd-pre-build-") as temporary:
            output = Path(temporary) / "dist"
            result = subprocess.run(
                ["uv", "build", "--wheel", "--out-dir", str(output)],
                cwd=REPOSITORY_ROOT,
                check=False,
                text=True,
                capture_output=True,
                env={**os.environ, "UV_NO_PROGRESS": "1"},
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            wheels = list(output.glob("sdd_pre-*.whl"))
            self.assertEqual(len(wheels), 1)
            with zipfile.ZipFile(wheels[0]) as archive:
                names = set(archive.namelist())
                self.assertIn("sdd_pre/cli.py", names)
                self.assertIn("sdd_pre/_workspace/AGENTS.md", names)
                harness = sorted(
                    name
                    for name in names
                    if name.startswith("sdd_pre/_workspace/.psp/harness/")
                    and not name.endswith("/")
                )
                self.assertEqual(harness, ["sdd_pre/_workspace/.psp/harness/HARNESS.md"])
                for forbidden in [
                    "harness.manifest.json",
                    "resolve-validation.mjs",
                    "run-handoff.mjs",
                    "bin/pre-sdd.mjs",
                ]:
                    self.assertFalse(any(name.endswith(forbidden) for name in names), forbidden)


if __name__ == "__main__":
    unittest.main()
