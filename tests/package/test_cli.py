from __future__ import annotations

import contextlib
import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "runtime"))

from sdd_pre import cli


TEMPLATE_ROOT = REPOSITORY_ROOT / "templates" / "workspace"


def snapshot(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_file():
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif path.is_dir():
            result[relative + "/"] = ""
    return result


class InitializeWorkspaceTests(unittest.TestCase):
    def test_initializes_current_directory_without_nesting(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "workspace"
            target.mkdir()
            original = Path.cwd()
            try:
                os.chdir(target)
                initialized = cli.initialize_workspace(".", TEMPLATE_ROOT)
            finally:
                os.chdir(original)

            self.assertEqual(initialized, target)
            for relative in [
                "AGENTS.md",
                "README.md",
                "package.json",
                "psp.project.yaml",
                ".agents/skills",
                "01-product-design",
                "02-architecture-design",
            ]:
                self.assertTrue((target / relative).exists(), relative)
            self.assertFalse((target / "workspace").exists())

    def test_conflict_lists_paths_and_has_zero_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            target = parent / "workspace"
            target.mkdir()
            (target / "README.md").write_text("user content\n", encoding="utf-8")
            before = snapshot(parent)

            with self.assertRaisesRegex(cli.SddPreError, "README.md"):
                cli.initialize_workspace(str(target), TEMPLATE_ROOT)

            self.assertEqual(snapshot(parent), before)
            self.assertEqual(list(parent.glob(".sdd-pre-stage-*")), [])

    def test_copy_failure_cleans_staging_and_preserves_user_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            target = parent / "workspace"
            target.mkdir()
            (target / "notes.txt").write_text("keep me\n", encoding="utf-8")
            before = snapshot(target)

            with mock.patch.object(cli, "_copy_template", side_effect=OSError("injected copy failure")):
                with self.assertRaisesRegex(OSError, "injected copy failure"):
                    cli.initialize_workspace(str(target), TEMPLATE_ROOT)

            self.assertEqual(snapshot(target), before)
            self.assertEqual(list(parent.glob(".sdd-pre-stage-*")), [])

    def test_mid_commit_failure_rolls_back_every_created_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            target = parent / "workspace"
            target.mkdir()
            (target / "notes.txt").write_text("keep me\n", encoding="utf-8")
            before = snapshot(target)
            real_commit = cli._commit_entry
            calls = 0

            def fail_second(source: Path, destination: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("injected commit failure")
                real_commit(source, destination)

            with mock.patch.object(cli, "_commit_entry", side_effect=fail_second):
                with self.assertRaisesRegex(OSError, "injected commit failure"):
                    cli.initialize_workspace(str(target), TEMPLATE_ROOT)

            self.assertEqual(snapshot(target), before)
            self.assertEqual(list(parent.glob(".sdd-pre-stage-*")), [])

    def test_conflict_created_during_commit_is_preserved_and_rolls_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            target = parent / "workspace"
            target.mkdir()
            real_commit = cli._commit_entry
            calls = 0

            def collide_second(source: Path, destination: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    destination.write_text("concurrent user file\n", encoding="utf-8")
                real_commit(source, destination)

            with mock.patch.object(cli, "_commit_entry", side_effect=collide_second):
                with self.assertRaisesRegex(cli.SddPreError, "新冲突"):
                    cli.initialize_workspace(str(target), TEMPLATE_ROOT)

            children = list(target.iterdir())
            self.assertEqual(len(children), 1)
            self.assertEqual(children[0].read_text(encoding="utf-8"), "concurrent user file\n")
            self.assertEqual(list(parent.glob(".sdd-pre-stage-*")), [])

    def test_reinitialization_never_updates_an_existing_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "workspace"
            target.mkdir()
            cli.initialize_workspace(str(target), TEMPLATE_ROOT)
            before = snapshot(target)

            with self.assertRaises(cli.SddPreError):
                cli.initialize_workspace(str(target), TEMPLATE_ROOT)

            self.assertEqual(snapshot(target), before)

    def test_rejects_file_missing_path_and_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            file_target = parent / "file"
            file_target.write_text("x", encoding="utf-8")
            with self.assertRaises(cli.SddPreError):
                cli.initialize_workspace(str(file_target), TEMPLATE_ROOT)
            with self.assertRaises(cli.SddPreError):
                cli.initialize_workspace(str(parent / "missing"), TEMPLATE_ROOT)

            link = parent / "link"
            real = parent / "real"
            real.mkdir()
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError:
                return
            with self.assertRaises(cli.SddPreError):
                cli.initialize_workspace(str(link), TEMPLATE_ROOT)

    def test_broken_symlink_is_a_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            target = parent / "workspace"
            target.mkdir()
            link = target / "README.md"
            try:
                link.symlink_to(parent / "missing")
            except OSError:
                return
            with self.assertRaisesRegex(cli.SddPreError, "README.md"):
                cli.initialize_workspace(str(target), TEMPLATE_ROOT)
            self.assertTrue(link.is_symlink())


class PublicInterfaceTests(unittest.TestCase):
    def test_help_exposes_only_init_and_agent_next_step(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as exit_context:
                cli.main(["--help"])
        self.assertEqual(exit_context.exception.code, 0)
        text = output.getvalue()
        self.assertIn("sdd-pre init .", text)
        for forbidden in ["npm", "Node", "Harness", "Resolver", "Handoff", "Consistency"]:
            self.assertNotIn(forbidden, text)

    def test_success_message_only_points_to_agent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "workspace"
            target.mkdir()
            output = io.StringIO()
            with mock.patch.object(cli, "_workspace_template", return_value=TEMPLATE_ROOT):
                with contextlib.redirect_stdout(output):
                    status = cli.main(["init", str(target)])
            self.assertEqual(status, 0)
            text = output.getvalue()
            self.assertIn("Agent", text)
            for forbidden in ["npm", "Node", "Harness", "Resolver"]:
                self.assertNotIn(forbidden, text)

    def test_user_guides_do_not_delegate_internal_commands(self) -> None:
        for path in [
            REPOSITORY_ROOT / "README.md",
            REPOSITORY_ROOT / "QUICKSTART.md",
            TEMPLATE_ROOT / "README.md",
        ]:
            text = path.read_text(encoding="utf-8")
            for forbidden in ["npm ", "node ", "Node.js", "harness:resolve", "run-handoff"]:
                self.assertNotIn(forbidden, text, f"{path}: {forbidden}")


if __name__ == "__main__":
    unittest.main()
