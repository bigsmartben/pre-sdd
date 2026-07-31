from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import tarfile
import unittest
import zipfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class DistributionTests(unittest.TestCase):
    def run_checked(self, command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
        result = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, **(env or {})},
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    @staticmethod
    def npm_command(*arguments: str) -> list[str]:
        if os.name == "nt":
            return ["cmd.exe", "/d", "/s", "/c", "npm " + " ".join(arguments)]
        return ["npm", *arguments]

    def test_uv_build_contains_cli_and_clean_workspace_template(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sdd-pre-build-") as temporary:
            output = Path(temporary) / "dist"
            result = subprocess.run(
                ["uv", "build", "--out-dir", str(output)],
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
                for required in [
                    "sdd_pre/_workspace/.agents/skills/visual-spec/SKILL.md",
                    "sdd_pre/_workspace/.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json",
                    "sdd_pre/_workspace/.agents/skills/user-path-cases/schemas/test-case-catalog.schema.json",
                    "sdd_pre/_workspace/.agents/skills/figma-workflow/schemas/figma-coverage.schema.json",
                    "sdd_pre/_workspace/.agents/skills/lit-ui/SKILL.md",
                    "sdd_pre/_workspace/.agents/skills/lit-ui/schemas/lit-visual-coverage.schema.json",
                    "sdd_pre/_workspace/.agents/skills/lit-ui/schemas/review-findings.schema.json",
                    "sdd_pre/_workspace/.agents/skills/lit-ui/scripts/validate.mjs",
                    "sdd_pre/_workspace/.agents/skills/implement-lit-ui/SKILL.md",
                    "sdd_pre/_workspace/.agents/skills/repair-visual-delivery/SKILL.md",
                    "sdd_pre/_workspace/.agents/skills/mockcase/runtime/mock-service-adapter.ts",
                ]:
                    self.assertIn(required, names, f"LIT_UI_SCAFFOLD_INCOMPLETE: {required}")
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
                    "canonical-ui.ts",
                    "refresh-projections.mjs",
                ]:
                    self.assertFalse(any(name.endswith(forbidden) for name in names), forbidden)
                for forbidden_segment in [
                    "/node_modules/",
                    "/dist/",
                    "/.vite/",
                    "/UIHTML/",
                    "/runtime-evidence/",
                ]:
                    self.assertFalse(
                        any(forbidden_segment in name for name in names),
                        f"SCAFFOLD_BUILD_OUTPUT_LEAK or PRODUCT_INSTANCE_IN_SCAFFOLD: {forbidden_segment}",
                    )
                for forbidden_prefix in [
                    "sdd_pre/_workspace/.psp/visual-spec/",
                    "sdd_pre/_workspace/src/ui/",
                    "sdd_pre/_workspace/UIHTML/",
                ]:
                    self.assertFalse(
                        any(name.startswith(forbidden_prefix) for name in names),
                        f"PRODUCT_INSTANCE_IN_SCAFFOLD: {forbidden_prefix}",
                    )

            sdists = list(output.glob("sdd_pre-*.tar.gz"))
            self.assertEqual(len(sdists), 1)
            with tarfile.open(sdists[0], "r:gz") as archive:
                names = {member.name for member in archive.getmembers() if member.isfile()}
                suffixes = {
                    name.split("/", 1)[1] if "/" in name else name
                    for name in names
                }
                for required in [
                    "templates/workspace/.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json",
                    "templates/workspace/.agents/skills/figma-workflow/schemas/figma-coverage.schema.json",
                    "templates/workspace/.agents/skills/lit-ui/schemas/lit-visual-coverage.schema.json",
                    "templates/workspace/.agents/skills/user-path-cases/schemas/test-case-catalog.schema.json",
                ]:
                    self.assertIn(required, suffixes, f"LIT_UI_SCAFFOLD_INCOMPLETE: {required}")

            environment = Path(temporary) / "environment"
            self.run_checked([sys.executable, "-m", "venv", str(environment)], REPOSITORY_ROOT)
            executable_root = environment / ("Scripts" if os.name == "nt" else "bin")
            python = executable_root / ("python.exe" if os.name == "nt" else "python")
            sdd_pre = executable_root / ("sdd-pre.exe" if os.name == "nt" else "sdd-pre")
            self.run_checked(
                [str(python), "-m", "pip", "install", "--no-deps", str(wheels[0])],
                REPOSITORY_ROOT,
                {"PIP_DISABLE_PIP_VERSION_CHECK": "1"},
            )

            workspace = Path(temporary) / "workspace"
            workspace.mkdir()
            self.run_checked([str(sdd_pre), "init", str(workspace)], REPOSITORY_ROOT)
            self.run_checked(self.npm_command("install", "--no-audit", "--no-fund"), workspace)
            self.run_checked(self.npm_command("run", "check"), workspace)
            self.run_checked(self.npm_command("run", "typecheck"), workspace)


if __name__ == "__main__":
    unittest.main()
