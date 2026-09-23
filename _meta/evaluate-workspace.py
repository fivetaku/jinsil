#!/usr/bin/env python3
"""Execute natural-language cases and grade machine-readable artifacts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias


Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]


class Arguments(argparse.Namespace):
    workspace: str = ""
    cases: str = ""
    runtime: str = "codex"
    check_only: bool = False
    timeout: int = 180


@dataclass(frozen=True, slots=True)
class Check:
    path: Path
    keys: tuple[str, ...]
    expected: Json


@dataclass(frozen=True, slots=True)
class Case:
    id: str
    prompt: str
    checks: tuple[Check, ...]


def decode(text: str, loader: Callable[[str], Json] = json.loads) -> Json:
    return loader(text)


def load_cases(path: Path, root: Path) -> list[Case]:
    data = decode(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise ValueError("cases must be a non-empty array")
    cases: list[Case] = []
    for raw in data:
        if not isinstance(raw, dict):
            raise ValueError("case must be an object")
        id_, prompt, checks = raw.get("id"), raw.get("prompt"), raw.get("checks")
        if not isinstance(id_, str) or not id_ or any(c.id == id_ for c in cases):
            raise ValueError("case id must be unique and non-empty")
        if not isinstance(prompt, str) or not prompt or not isinstance(checks, list) or not checks:
            raise ValueError("case needs a prompt and at least one check")
        parsed: list[Check] = []
        for check in checks:
            if not isinstance(check, dict):
                raise ValueError("check must be an object")
            name, keys = check.get("path"), check.get("keys")
            if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError("check path must stay in workspace")
            target = root / name
            if not target.resolve().is_relative_to(root):
                raise ValueError("check path escapes workspace")
            if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys) or "equals" not in check:
                raise ValueError("check needs string keys and equals")
            parsed.append(Check(target, tuple(k for k in keys if isinstance(k, str)), check["equals"]))
        cases.append(Case(id_, prompt, tuple(parsed)))
    return cases


def score(case: Case, root: Path) -> list[str]:
    failures: list[str] = []
    for check in case.checks:
        try:
            if not check.path.resolve().is_relative_to(root):
                raise ValueError("result symlink escapes workspace")
            actual = decode(check.path.read_text(encoding="utf-8"))
            for key in check.keys:
                if not isinstance(actual, dict) or key not in actual:
                    raise ValueError(f"missing field: {key}")
                actual = actual[key]
            if json.dumps(actual, sort_keys=True) != json.dumps(check.expected, sort_keys=True):
                failures.append(f"{check.path.relative_to(root)}:{'.'.join(check.keys)} mismatch")
        except (OSError, ValueError) as error:
            failures.append(str(error))
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument("workspace")
    _ = parser.add_argument("cases")
    _ = parser.add_argument("--runtime", choices=("codex", "claude"), default="codex")
    _ = parser.add_argument("--check-only", action="store_true")
    _ = parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args(namespace=Arguments())
    root = Path(args.workspace).expanduser().resolve()
    try:
        if not root.is_dir() or args.timeout <= 0:
            raise ValueError("workspace must exist and timeout must be positive")
        cases = load_cases(Path(args.cases), root)
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 2
    failed = False
    for case in cases:
        start = time.monotonic()
        errors: list[str] = []
        if not args.check_only:
            command = (
                ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", str(root), case.prompt]
                if args.runtime == "codex" else
                ["claude", "-p", case.prompt, "--permission-mode", "acceptEdits",
                 "--allowedTools", "Read,Write,Edit,Glob,Grep"]
            )
            try:
                result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=args.timeout, check=False)
                if result.returncode:
                    errors.append(f"runtime exited {result.returncode}")
            except (OSError, subprocess.TimeoutExpired) as error:
                errors.append(str(error))
        errors.extend(score(case, root))
        failed = failed or bool(errors)
        print(json.dumps({
            "id": case.id, "status": "fail" if errors else "pass", "errors": errors,
            "runtime": None if args.check_only else args.runtime,
            "mode": "artifact_only" if args.check_only else "live_runtime",
            "elapsed_seconds": round(time.monotonic() - start, 3),
        }), flush=True)
        if errors and not args.check_only:
            break
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
