#!/usr/bin/env python3
"""Inspect generated hook artifacts without executing or trusting them."""

from __future__ import annotations

import hashlib
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Final, TypeAlias


Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]
CONFIGURATIONS: Final = {
    "claude": (".claude/settings.json", ".claude/settings.local.json"),
    "codex": (".codex/hooks.json",),
}


def document(path: Path, decode: Callable[[str], Json] = json.loads) -> dict[str, Json]:
    value = decode(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected JSON object")
    return value


def registrations(config: dict[str, Json]) -> list[Json]:
    hooks = config.get("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("hooks must be an object")
    entries: list[Json] = []
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            raise ValueError(f"{event}: expected hook groups")
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise ValueError(f"{event}: malformed hook group")
            handlers = group["hooks"]
            assert isinstance(handlers, list)
            for handler in handlers:
                if not isinstance(handler, dict):
                    raise ValueError(f"{event}: malformed handler")
                if handler.get("type") != "command":
                    continue
                command = handler.get("command")
                if not isinstance(command, str) or not command.strip():
                    raise ValueError(f"{event}: empty command")
                entries.append({"event": event, "matcher": group.get("matcher", ""), "command": command})
    return entries


def capture_inventory(root: Path, runtimes: list[str]) -> dict[str, Json]:
    """Record the generated baseline; this is not signed runtime evidence."""
    inventory: dict[str, Json] = {}
    for runtime in runtimes:
        hashes: dict[str, Json] = {}
        for path in sorted((root / f".{runtime}").rglob("*")):
            if path.is_file() and (path.suffix == ".sh" or path.name.endswith(".json.template")):
                hashes[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
        configs: dict[str, Json] = {
            name: registrations(document(root / name))
            for name in CONFIGURATIONS[runtime] if (root / name).is_file()
        }
        inventory[runtime] = {"artifacts": hashes, "configurations": configs}
    return inventory


def local_path(root: Path, name: str) -> Path:
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"not project-relative: {name}")
    path = root / relative
    if any(parent.is_symlink() for parent in (path, *path.parents) if parent != root and root in parent.parents):
        raise ValueError(f"symlink artifact: {name}")
    return path


def inspect_workspace(root: Path) -> dict[str, Json]:
    errors: list[Json] = []
    reports: dict[str, Json] = {}
    try:
        metadata = document(local_path(root, "_meta/structure.json"))
        options = metadata.get("generation_options")
        if not isinstance(options, dict):
            raise ValueError("_meta/structure.json: missing generation_options")
        inventory = options.get("harness_inventory")
        targets = metadata.get("target_runtimes")
        if not isinstance(inventory, dict) or not isinstance(targets, list) or set(inventory) != set(targets):
            raise ValueError("_meta/structure.json: missing or inconsistent harness_inventory")
        for runtime, expected in inventory.items():
            if runtime not in CONFIGURATIONS or not isinstance(expected, dict):
                raise ValueError("_meta/structure.json: invalid runtime inventory")
            artifacts, configs = expected.get("artifacts"), expected.get("configurations")
            if not isinstance(artifacts, dict) or not isinstance(configs, dict):
                raise ValueError("_meta/structure.json: invalid artifacts/configurations")
            for name, digest in artifacts.items():
                try:
                    actual = hashlib.sha256(local_path(root, name).read_bytes()).hexdigest()
                    if actual != digest:
                        raise ValueError(f"{name}: modified since generation")
                except (OSError, ValueError) as error:
                    errors.append(str(error))
            settings: dict[str, Json] = {}
            found = False
            for name in CONFIGURATIONS[runtime]:
                try:
                    path = local_path(root, name)
                    if not path.exists() and name not in configs:
                        settings[name] = {"state": "not_registered"}
                        continue
                    config = document(path)
                    entries = registrations(config)
                    wanted = configs.get(name, [])
                    if not isinstance(wanted, list) or any(entry not in entries for entry in wanted):
                        raise ValueError(f"{name}: generated registrations missing or changed")
                    found = found or bool(entries)
                    settings[name] = {
                        "state": "entries_present" if entries else "not_registered",
                        "entries": entries, "disable_all_hooks": config.get("disableAllHooks", False),
                    }
                except (OSError, ValueError) as error:
                    errors.append(f"{name}: {error}")
                    settings[name] = {"state": "error"}
            reports[runtime] = {
                "artifacts": artifacts, "configuration": settings,
                "registration": "registered" if found else "not_registered",
            }
    except (OSError, ValueError, TypeError) as error:
        errors.append(str(error))
    return {
        "schema_version": 1, "status": "error" if errors else "ok",
        "trust": "unknown", "activation": "unverified", "runtimes": reports,
        "live_observations": [], "errors": errors,
        "scope": "project-local static inventory; no commands executed or effective trust inferred",
    }


def main() -> int:
    root = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    report = inspect_workspace(root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(bool(report["errors"]))


if __name__ == "__main__":
    sys.exit(main())
