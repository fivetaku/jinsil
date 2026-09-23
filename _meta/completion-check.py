#!/usr/bin/env python3
"""Run a real project check and bind its exit status to the tested code snapshot."""

from __future__ import annotations

import argparse
from collections.abc import Callable
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from tempfile import NamedTemporaryFile
from typing import TypeAlias


Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]
INPUT_ROOTS = ("src", "tests", "scripts", "evals", "prompts", "config")
ROOT_INPUTS = ("package.json", "package-lock.json", "bun.lock", "pyproject.toml", "requirements.txt",
               "uv.lock", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "Makefile", "tsconfig.json",
               "pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg", "setup.py", "conftest.py",
               ".coveragerc", ".swcrc", ".npmrc", ".yarnrc.yml", ".cargo/config.toml")
ROOT_CONFIG_PATTERNS = (".env", ".env.*", "jest.config.*", "vitest.config.*", "vite.config.*",
                        "webpack.config.*", "babel.config.*", ".babelrc*", ".mocharc.*", "tsconfig*.json")
SNAPSHOT_VERSION = 2


class Arguments(argparse.Namespace):
    action: str = ""
    timeout: int = 300
    command: list[str] = []


def snapshot(root: Path) -> tuple[str, int]:
    files = {root / name for name in ROOT_INPUTS if (root / name).is_file() or (root / name).is_symlink()}
    for pattern in ROOT_CONFIG_PATTERNS:
        files.update(path for path in root.glob(pattern) if path.is_file() or path.is_symlink())
    for name in INPUT_ROOTS:
        files.update(path for path in (root / name).rglob("*") if path.is_file()
                     and not any(part in {"__pycache__", ".pytest_cache", "node_modules", ".git"} for part in path.parts)
                     and path.name not in {".gitkeep", ".DS_Store", "README.md"}
                     and path.suffix not in (".pyc", ".pyo"))
    digest = hashlib.sha256()
    for path in sorted(files):
        if not path.resolve().is_relative_to(root):
            raise ValueError("verification input escapes workspace")
        content = path.read_bytes()
        metadata = {"path": str(path.relative_to(root)), "mode": path.stat().st_mode & 0o7777,
                    "bytes": len(content)}
        digest.update(json.dumps(metadata, sort_keys=True).encode() + b"\0" + content)
    return digest.hexdigest(), len(files)


def status(root: Path, decode: Callable[[str], Json] = json.loads) -> tuple[dict[str, Json], int]:
    current, count = snapshot(root)
    result_path = root / "_meta/completion-result.json"
    if not result_path.exists():
        return {"status": "unverified" if count else "not_required", "input_files": count}, int(count > 0)
    if result_path.is_symlink():
        raise ValueError("completion result must be local")
    result = decode(result_path.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise ValueError("invalid completion result")
    valid = (type(result.get("exit_code")) is int and result["exit_code"] == 0
             and result.get("snapshot_version") == SNAPSHOT_VERSION
             and result.get("status") == "pass"
             and result.get("before_sha256") == current == result.get("after_sha256"))
    return {"status": "pass" if valid else "fail_or_stale", "input_files": count}, int(not valid)


def run(root: Path, command: list[str], timeout: int) -> int:
    if not command or timeout <= 0:
        raise ValueError("a real check command and positive timeout are required")
    before, count = snapshot(root)
    try:
        result = subprocess.run(command, cwd=root, check=False, timeout=timeout)
        exit_code: int | None = result.returncode
    except (OSError, subprocess.TimeoutExpired):
        exit_code = None
    after, _ = snapshot(root)
    passed = exit_code == 0 and before == after
    record = {
        "schema_version": 1, "status": "pass" if passed else "fail",
        "snapshot_version": SNAPSHOT_VERSION,
        "executable": Path(command[0]).name,
        "command_sha256": hashlib.sha256(json.dumps(command).encode()).hexdigest(),
        "exit_code": exit_code, "input_files": count, "before_sha256": before, "after_sha256": after,
    }
    target = root / "_meta/completion-result.json"
    if target.is_symlink():
        raise ValueError("completion result must be local")
    with NamedTemporaryFile("w", dir=target.parent, encoding="utf-8", delete=False) as stream:
        temporary = Path(stream.name)
        _ = stream.write(json.dumps(record, indent=2) + "\n")
    _ = temporary.replace(target)
    print(json.dumps(record))
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    run_parser = commands.add_parser("run", allow_abbrev=False)
    _ = run_parser.add_argument("--timeout", type=int, default=300)
    _ = run_parser.add_argument("command", nargs=argparse.REMAINDER)
    _ = commands.add_parser("status")
    args = parser.parse_args(namespace=Arguments())
    root = Path(__file__).resolve().parents[1]
    try:
        if args.action == "status":
            if args.command:
                raise ValueError("status takes no command")
            report, code = status(root)
            print(json.dumps(report))
            return code
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        return run(root, command, args.timeout)
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
