"""The only public sdd-pre command line interface."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from importlib import resources
from pathlib import Path
from typing import Sequence


class SddPreError(Exception):
    """A user-facing initialization error with a stable category."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _workspace_template() -> Path:
    packaged = resources.files("sdd_pre").joinpath("_workspace")
    if packaged.is_dir():
        return Path(str(packaged))

    source_checkout = Path(__file__).resolve().parents[2] / "templates" / "workspace"
    if source_checkout.is_dir():
        return source_checkout
    raise SddPreError("SDD_PRE_PACKAGE_INVALID", "安装包缺少工作区模板。")


def _target_directory(value: str) -> Path:
    target = Path(value)
    if not target.is_absolute():
        target = Path.cwd() / target
    target = target.absolute()
    try:
        target.lstat()
    except FileNotFoundError as error:
        raise SddPreError("SDD_PRE_TARGET_INVALID", f"目标目录不存在：{target}") from error
    if target.is_symlink() or not target.is_dir():
        raise SddPreError("SDD_PRE_TARGET_INVALID", f"目标必须是已存在的真实目录：{target}")
    return target


def _owned_entries(template_root: Path) -> list[Path]:
    entries = sorted(template_root.iterdir(), key=lambda path: path.name)
    if not entries:
        raise SddPreError("SDD_PRE_PACKAGE_INVALID", "安装包中的工作区模板为空。")
    return entries


def _copy_template(template_root: Path, staging: Path, entries: Sequence[Path]) -> None:
    for source in entries:
        destination = staging / source.name
        if source.is_symlink():
            raise SddPreError("SDD_PRE_PACKAGE_INVALID", f"工作区模板不得包含符号链接：{source.name}")
        if source.is_dir():
            shutil.copytree(source, destination)
        elif source.is_file():
            shutil.copy2(source, destination)
        else:
            raise SddPreError("SDD_PRE_PACKAGE_INVALID", f"工作区模板包含不支持的路径：{source.name}")


def _validate_staging(staging: Path) -> None:
    required = [
        "AGENTS.md",
        "README.md",
        "package.json",
        "psp.project.yaml",
        ".agents/skills",
        ".psp/harness/HARNESS.md",
        "01-product-design",
        "02-architecture-design",
    ]
    missing = [path for path in required if not (staging / path).exists()]
    if missing:
        raise SddPreError(
            "SDD_PRE_TEMPLATE_INVALID",
            "工作区模板缺少必要路径：" + ", ".join(missing),
        )

    for root, directories, files in os.walk(staging):
        current = Path(root)
        for name in [*directories, *files]:
            path = current / name
            if path.is_symlink():
                relative = path.relative_to(staging).as_posix()
                raise SddPreError("SDD_PRE_TEMPLATE_INVALID", f"工作区模板不得包含符号链接：{relative}")
        forbidden = sorted(set(directories) & {"node_modules", "dist", ".vite"})
        if forbidden:
            relative = current.relative_to(staging).as_posix()
            raise SddPreError(
                "SDD_PRE_TEMPLATE_INVALID",
                f"工作区模板包含构建或依赖目录：{relative}/{forbidden[0]}",
            )

    harness_files = sorted(
        path.relative_to(staging / ".psp" / "harness").as_posix()
        for path in (staging / ".psp" / "harness").rglob("*")
        if path.is_file()
    )
    if harness_files != ["HARNESS.md"]:
        raise SddPreError(
            "SDD_PRE_TEMPLATE_INVALID",
            "使用者治理目录必须且只能包含 HARNESS.md。",
        )


def _commit_entry(source: Path, destination: Path) -> None:
    if os.path.lexists(destination):
        raise SddPreError(
            "SDD_PRE_PATH_CONFLICT",
            f"提交初始化结果时发现新冲突，已回滚：{destination.name}",
        )
    os.replace(source, destination)


def initialize_workspace(target_value: str, template_root: Path | None = None) -> Path:
    """Copy a packaged workspace into an existing real directory transactionally."""

    target = _target_directory(target_value)
    template = (template_root or _workspace_template()).absolute()
    entries = _owned_entries(template)
    collisions = [
        entry.name
        for entry in entries
        if os.path.lexists(target / entry.name)
    ]
    if collisions:
        raise SddPreError(
            "SDD_PRE_PATH_CONFLICT",
            "以下工作区路径已存在，未写入任何文件：" + ", ".join(collisions),
        )

    staging = Path(tempfile.mkdtemp(prefix=".sdd-pre-stage-", dir=target.parent))
    committed: list[str] = []
    try:
        _copy_template(template, staging, entries)
        _validate_staging(staging)
        for entry in entries:
            _commit_entry(staging / entry.name, target / entry.name)
            committed.append(entry.name)
    except Exception as error:
        rollback_failures: list[str] = []
        for name in reversed(committed):
            try:
                os.replace(target / name, staging / name)
            except OSError as rollback_error:
                rollback_failures.append(f"{name}: {rollback_error}")
        if rollback_failures:
            raise SddPreError(
                "SDD_PRE_ROLLBACK_FAILED",
                f"初始化失败且回滚不完整：{error}；" + "；".join(rollback_failures),
            ) from error
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return target


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sdd-pre",
        description="初始化一个由本地 Agent 使用的设计工作区。",
        epilog="示例：sdd-pre init .",
    )
    subcommands = parser.add_subparsers(dest="command", metavar="COMMAND")
    init = subcommands.add_parser(
        "init",
        help="在已存在的真实目录中初始化工作区",
        description="将当前目录初始化为本地 Agent 工作区。",
    )
    init.add_argument("target", metavar="DIRECTORY", help="已存在的真实目标目录；正式用法为 .")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    if arguments.command is None:
        parser.print_help()
        return 0
    try:
        target = initialize_workspace(arguments.target)
    except SddPreError as error:
        print(f"[{error.code}] {error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover - last-resort CLI boundary
        print(f"[SDD_PRE_INITIALIZATION_FAILED] {error}", file=sys.stderr)
        return 1

    print(f"工作区已初始化：{target}")
    print("下一步：在此目录中向 Agent 提出产品设计或架构设计任务。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
