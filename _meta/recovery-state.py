#!/usr/bin/env python3
"""Read unfinished work; pausing or cancelling is never completion."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TypeAlias, TypedDict


Json: TypeAlias = str | int | bool | None | list["Json"] | dict[str, "Json"]


class RecoveryReport(TypedDict):
    status: str
    reason: str
    unfinished: list[str]
    errors: list[str]
    block_completion: bool


def inspect_state(root: Path, decode: Callable[[str], Json] = json.loads) -> RecoveryReport:
    unfinished: list[str] = []
    errors: list[str] = []
    status, reason = "active", ""
    try:
        override = root / "_meta/recovery-state.json"
        if override.exists():
            state = decode(override.read_text(encoding="utf-8"))
            if not isinstance(state, dict):
                raise ValueError("recovery-state.json must be an object")
            selected, explanation = state.get("status"), state.get("reason", "")
            if selected not in ("active", "paused", "cancelled"):
                raise ValueError("recovery-state status must be active, paused or cancelled")
            if not isinstance(explanation, str) or (selected != "active" and not explanation.strip()):
                raise ValueError("pause/cancellation requires the user's reason")
            status, reason = selected, explanation
        for name in ("TEAM_PLAN.md", "TEAM_PROGRESS.md", "VERIFICATION.md"):
            path = root / "_meta/orchestration" / name
            if not path.exists():
                continue
            fenced = False
            verification: str | None = None
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if line.strip().startswith(("```", "~~~")):
                    fenced = not fenced
                if fenced:
                    continue
                if re.match(r"^\s*[-*] \[ \] ", line) or re.match(
                    r"^### \[[0-9TZ:.\-]+\] (pending intent classification|classified: (?!.*closed).+)$", line,
                ):
                    unfinished.append(f"{name}:{number}: {line.strip()}")
                if name == "VERIFICATION.md" and line.strip().startswith("status:"):
                    verification = line.strip().partition(":")[2].strip()
                if name == "TEAM_PROGRESS.md" and re.fullmatch(
                    r"\| [A-Za-z0-9_-]+ \| (pending|running|blocked) \|", line.strip(),
                ):
                    unfinished.append(f"{name}:{number}: {line.strip()}")
            if verification is not None and verification != "pass":
                unfinished.append(f"{name}: status: {verification}")
        domain_check = root / "_meta/checks/operations.py"
        metadata = decode((root / "_meta/structure.json").read_text(encoding="utf-8"))
        options = metadata.get("generation_options") if isinstance(metadata, dict) else None
        if not isinstance(options, dict):
            raise ValueError("missing generated recovery metadata")
        if options.get("archetype") == "development":
            checker = root / "_meta/completion-check.py"
            if not checker.is_file():
                raise ValueError("required development completion checker is missing")
            hashes = options.get("checker_sha256")
            if (
                checker.is_symlink() or not isinstance(hashes, dict)
                or hashes.get("_meta/completion-check.py") != hashlib.sha256(checker.read_bytes()).hexdigest()
            ):
                raise ValueError("development completion checker differs from the generated baseline")
            completion = subprocess.run(
                [sys.executable, "-B", str(checker), "status"], cwd=root,
                capture_output=True, text=True, timeout=30, check=False,
            )
            if completion.returncode:
                unfinished.append("development completion check: " + completion.stdout + completion.stderr)
            else:
                result = decode(completion.stdout)
                if not isinstance(result, dict) or result.get("status") not in ("pass", "not_required"):
                    raise ValueError("development completion checker returned an invalid status")
                count = result.get("input_files")
                if type(count) is not int or count < 0 or (result["status"] == "not_required" and count != 0):
                    raise ValueError("development completion checker returned an invalid input count")
        if options.get("archetype") == "operations" and not domain_check.is_file():
            raise ValueError("required Operations checker is missing")
        if domain_check.is_file():
            result = subprocess.run(
                [sys.executable, "-B", str(domain_check)], cwd=root,
                capture_output=True, text=True, timeout=30, check=False,
            )
            if result.returncode:
                errors.append(result.stdout + result.stderr)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        errors.append(str(error))
    return {
        "status": status, "reason": reason, "unfinished": unfinished, "errors": errors,
        "block_completion": bool(errors or (status == "active" and unfinished)),
    }


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    report = inspect_state(root)
    print(json.dumps(report, ensure_ascii=False))
    return int(report["block_completion"])


if __name__ == "__main__":
    sys.exit(main())
