#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
HOOK_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
WORKSPACE_BUILDER_PROJECT_ROOT="${WORKSPACE_BUILDER_PROJECT_ROOT:-$HOOK_ROOT}" PAYLOAD="$INPUT" python3 <<'PY'
import os
import re
import shlex
from pathlib import Path

BACKTICK = chr(96)
CONTROL_PUNCTUATION = ";&|(){}<>" + BACKTICK + "\n"
CONTROL_WORDS = {"then", "do", "else", "elif", "fi", "done", "esac"}
WRAPPERS = {"builtin", "command", "env", "exec", "nohup", "sudo", "time"}
WRAPPER_OPTIONS_WITH_VALUE = {
    "env": {"-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"},
    "exec": {"-a"},
    "sudo": {"-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-T", "--command-timeout", "-t", "--type", "-U", "--other-user", "-u", "--user"},
    "time": {"-f", "--format", "-o", "--output"},
}

def shell_segments(source):
    try:
        lexer = shlex.shlex(source, posix=True, punctuation_chars=CONTROL_PUNCTUATION)
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return None
    segments = []
    segment = []
    for token in tokens:
        is_boundary = token in CONTROL_WORDS or (
            token and all(char in CONTROL_PUNCTUATION for char in token)
        )
        if is_boundary:
            if segment:
                segments.append(segment)
                segment = []
        else:
            segment.append(token)
    if segment:
        segments.append(segment)
    return segments

def git_subcommand(argv):
    index = 1
    options_with_value = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"}
    while index < len(argv):
        token = argv[index]
        if token in options_with_value:
            index += 2
        elif token.startswith("-"):
            index += 1
        else:
            return token, argv[index + 1:]
    return "", []

def strip_command_prefix(argv, details=None):
    remaining = list(argv)
    wrapped = False
    while remaining and "=" in remaining[0] and not remaining[0].startswith("="):
        name, _, _ = remaining[0].partition("=")
        if not name.replace("_", "a").isalnum() or name[0].isdigit():
            break
        remaining = remaining[1:]
    while remaining and Path(remaining[0]).name in WRAPPERS:
        wrapped = True
        wrapper = Path(remaining[0]).name
        if details is not None:
            details.setdefault("wrappers", []).append(wrapper)
        remaining = remaining[1:]
        while remaining and remaining[0].startswith("-"):
            option = remaining[0]
            if details is not None and isinstance(option, ShellExpansion):
                raise ValueError("computed wrapper option cannot be inspected")
            if option == "--":
                remaining = remaining[1:]
                break
            value_options = WRAPPER_OPTIONS_WITH_VALUE.get(wrapper, set())
            value_option = option.partition("=")[0] if option.startswith("--") else option
            attached_value = any(
                option.startswith(long_option + "=")
                for long_option in value_options
                if long_option.startswith("--")
            ) or any(
                option.startswith(short_option) and option != short_option
                for short_option in value_options
                if short_option.startswith("-") and not short_option.startswith("--")
            )
            if wrapper == "env" and not option.startswith("--"):
                # A value-taking short option ends the cluster. Characters in
                # its attached value are not additional options.
                for position, flag in enumerate(option[1:], start=1):
                    if "-" + flag in value_options:
                        value_option = "-" + flag
                        attached_value = position + 1 < len(option)
                        break
            if details is not None and wrapper == "env":
                if value_option in {"-C", "--chdir", "-S", "--split-string"}:
                    details["uninspectable_environment"] = True
                if value_option in {"-S", "--split-string"}:
                    details["uninspectable_split_string"] = True
            if value_option in value_options and not attached_value:
                if len(remaining) < 2:
                    return None
                remaining = remaining[2:]
            else:
                remaining = remaining[1:]
            if attached_value:
                continue
        while wrapper == "env" and remaining and "=" in remaining[0]:
            if isinstance(remaining[0], ShellExpansion) and not remaining[0].env_assignment:
                break  # Keep an unresolved executable or a word that may split into argv.
            remaining = remaining[1:]
    if wrapped and details is None:
        protected_executables = {"chmod", "docker", "find", "git", "rm"}
        for index, token in enumerate(remaining):
            if Path(token).name in protected_executables:
                return remaining[index:]
    return remaining

class ShellExpansion(str):
    """A word whose shell value has not been resolved by this inspector."""
    env_assignment = False

def completion_invocation(argv):
    """Recognize only the actual runner position, never interpreter names in test arguments."""
    details = {}
    argv = strip_command_prefix(argv, details)
    if details.get("uninspectable_split_string"):
        raise ValueError("env split-string executable cannot be inspected")
    if not argv:
        return None
    if isinstance(argv[0], ShellExpansion):
        raise ValueError("computed executable cannot be inspected")
    index = 0
    module = False
    entry = None
    if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", Path(argv[0]).name):
        index = 1
        while index < len(argv):
            option = argv[index]
            if isinstance(option, ShellExpansion):
                raise ValueError("computed Python option or entry cannot be inspected")
            if option == "--":
                index += 1
                break
            if not option.startswith("-"):
                break
            if option == "-" or option.startswith("--help") or option == "--version":
                return None
            if option == "--check-hash-based-pycs":
                index += 2
                continue
            if option.startswith("--check-hash-based-pycs="):
                index += 1
                continue
            if option.startswith("--"):
                return None
            cluster = option[1:]
            advance = 1
            for position, flag in enumerate(cluster):
                if flag in "hVc":
                    return None
                if flag in "mWX":
                    attached = cluster[position + 1:]
                    if not attached and index + 1 >= len(argv):
                        return None
                    value = attached or argv[index + 1]
                    advance = 1 if attached else 2
                    if flag == "m":
                        module, entry = True, value
                    break
                if flag not in "bBdEiIOPqRsSuvx":
                    return None
            index += advance
            if entry is not None:
                break
    if entry is None:
        if index >= len(argv):
            return None
        entry = argv[index]
        index += 1
    if isinstance(entry, ShellExpansion):
        raise ValueError("computed runner entry cannot be inspected")
    if (module and entry != "_meta.completion-check") or (not module and Path(entry).name != "completion-check.py"):
        return None
    args = argv[index:]
    if args and isinstance(args[0], ShellExpansion):
        raise ValueError("computed completion action cannot be inspected")
    if args == ["status"]:
        return (("module:" + entry) if module else entry, [], details, "status")
    if not args or args[0] != "run":
        return None
    args = args[1:]
    while args:
        if args[:1] == ["--timeout"]:
            if len(args) < 2:
                raise ValueError("completion timeout is missing")
            if int(args[1]) <= 0:
                raise ValueError("completion timeout must be positive")
            args = args[2:]
        elif args[0].startswith("--timeout="):
            if int(args[0].partition("=")[2]) <= 0:
                raise ValueError("completion timeout must be positive")
            args = args[1:]
        elif args[0] == "--":
            break
        elif args[0].startswith("-"):
            raise ValueError("unsupported completion runner option")
        else:
            break
    if args[:1] == ["--"]:
        args = args[1:]
    return (("module:" + entry) if module else entry, args, details, "run") if args else None

def completion_child_argv(argv):
    invocation = completion_invocation(argv)
    return invocation[1] if invocation is not None and invocation[3] == "run" else None

def logical_token_end(source, start, token):
    """Match syntax across active continuations; callers own quote/escape context."""
    index = start
    for character in token:
        while source[index:index + 2] == "\\\n":
            index += 2
        if source[index:index + 1] != character:
            return None
        index += 1
    return index

def substitution_end(source, start, depth):
    if depth > 8:
        raise ValueError("shell substitution nesting exceeds safety limit")
    backtick = source[start] == BACKTICK
    index = start + 1 if backtick else logical_token_end(source, start, "$(")
    if index is None:
        raise ValueError("unrecognized substitution opener")
    level, quote = 1, None
    while index < len(source):
        character = source[index]
        if character == "\\" and (backtick or quote != "'"):
            index += 2
            continue
        if backtick:
            if character == BACKTICK:
                return index
        elif quote != "'" and (
            character == BACKTICK or logical_token_end(source, index, "$(") is not None
        ):
            index = substitution_end(source, index, depth + 1) + 1
            continue
        elif quote:
            if character == quote:
                quote = None
        elif character in {"'", '"'}:
            quote = character
        elif character == "(":
            level += 1
        elif character == ")":
            level -= 1
            if level == 0:
                return index
        index += 1
    raise ValueError("unclosed shell substitution")

def inspect_substitution(source, start, depth):
    end = substitution_end(source, start, depth)
    backtick = source[start] == BACKTICK
    inner_start = start + 1 if backtick else logical_token_end(source, start, "$(")
    if inner_start is None:
        raise ValueError("unrecognized substitution opener")
    inner = source[inner_start:end]
    if backtick:
        inner = inner.replace("\\" + BACKTICK, BACKTICK)
    nested = completion_segments(inner, depth + 1)
    if any(completion_invocation(argv) is not None for argv in nested):
        raise ValueError("completion inside shell substitution requires a simple invocation")
    return end

def parameter_end(source, start, depth, double_quoted=False):
    """Return the closing index and cardinality uncertainty from the nested word."""
    if depth > 8:
        raise ValueError("parameter nesting exceeds safety limit")
    index, quote = logical_token_end(source, start, "${"), None
    if index is None:
        raise ValueError("unrecognized parameter opener")
    head, cursor = [], index
    while cursor < len(source):
        if source[cursor:cursor + 2] == "\\\n":
            cursor += 2
            continue
        character = source[cursor]
        if not (character.isalnum() or character in "_@!#*[]"):
            break
        head.append(character)
        cursor += 1
    may_split = bool(re.match(
        r"(?:@|!|[A-Za-z_][A-Za-z_0-9]*\[@\])",
        "".join(head),
    ))
    while index < len(source):
        character = source[index]
        active = quote != "'" or double_quoted
        if character == "\\" and active:
            index += 2
            continue
        if active and (
            character == BACKTICK or logical_token_end(source, index, "$(") is not None
        ):
            index = inspect_substitution(source, index, depth + 1) + 1
            continue
        if active and logical_token_end(source, index, "${") is not None:
            end, nested_split = parameter_end(
                source, index, depth + 1, double_quoted or quote == '"',
            )
            may_split = may_split or nested_split
            index = end + 1
            continue
        positional_end = logical_token_end(source, index, "$@") if active else None
        if positional_end is not None:
            may_split = True
            index = positional_end
            continue
        if active and (
            logical_token_end(source, index, "$'") is not None
            or logical_token_end(source, index, '$"') is not None
        ):
            # Shell-specific quoted transformations inside a parameter word can
            # expose expansion syntax again; do not certify them as one argv.
            may_split = True
        if quote:
            if character == quote:
                quote = None
        elif character == '"' or (character == "'" and not double_quoted):
            quote = character
        elif character == "}":
            return index, may_split
        index += 1
    raise ValueError("unclosed parameter expansion")

def completion_segments(source, depth=0):
    """Inspect words without executing expansions or granting redirect privileges."""
    if depth > 8:
        raise ValueError("shell substitution nesting exceeds safety limit")
    commands, words, current = [], [], []
    index, quote = 0, None
    expanded_word = expanded_command = redirected = False
    literal_assignment = may_split = False
    brace_depth = 0

    def emit_word():
        nonlocal expanded_word, literal_assignment, may_split, brace_depth
        if current:
            raw = "".join(current)
            value = ShellExpansion(raw) if expanded_word else shlex.split(raw, comments=False)[0]
            if isinstance(value, ShellExpansion):
                value.env_assignment = literal_assignment and not may_split
            words.append((raw, value, False))
            current.clear()
        expanded_word = literal_assignment = may_split = False
        brace_depth = 0

    def emit_command():
        nonlocal expanded_command, redirected
        emit_word()
        plain = []
        position = 0
        while position < len(words):
            if words[position][2]:
                # Remove redirects only to identify the executable. A recognized
                # completion call is refused below, never authorized by this view.
                position += 1
                if position < len(words) and not words[position][2]:
                    position += 1
                continue
            plain.append(words[position])
            position += 1
        while plain and plain[0][0] in {"if", "then", "elif", "else", "while", "until", "do", "!"}:
            plain.pop(0)
        argv = [word[1] for word in plain]
        if argv:
            invocation = completion_invocation(argv)
            if invocation is not None and (redirected or expanded_command):
                raise ValueError("redirected or expanded completion call requires a simple invocation")
            commands.append(argv)
        words.clear()
        expanded_command = redirected = False

    while index < len(source):
        character = source[index]
        if character == "\\" and quote != "'":
            if source[index + 1:index + 2] == "=":
                literal_assignment = True
            if source[index:index + 2] != "\\\n":
                current.append(source[index:index + 2])
            index += 2
            continue
        if quote != "'" and (
            character == BACKTICK or logical_token_end(source, index, "$(") is not None
        ):
            end = inspect_substitution(source, index, depth)
            current.append(source[index:end + 1])
            expanded_word = expanded_command = True
            may_split = may_split or quote is None
            index = end + 1
            continue
        quoted_start = None
        if quote is None and character == "$":
            for delimiter in ("'", '"'):
                quoted_start = logical_token_end(source, index, "$" + delimiter)
                if quoted_start is not None:
                    break
        if quoted_start is not None:
            delimiter = source[quoted_start - 1]
            end = quoted_start
            while end < len(source):
                if source[end] == "\\":
                    end += 2
                    continue
                if source[end] == delimiter:
                    break
                end += 1
            if end >= len(source):
                raise ValueError("unclosed shell string")
            inner = source[quoted_start:end]
            if delimiter == "'" and "\\" not in inner:
                current.append("'" + inner + "'")  # Exact simple ANSI-C literal, not shell syntax.
                literal_assignment = literal_assignment or "=" in inner
            else:
                current.append(source[index:end + 1])
                expanded_word = expanded_command = True
                # Locale translation is not evaluated and cannot certify one argv.
                may_split = may_split or delimiter == '"'
            index = end + 1
            continue
        if quote != "'" and logical_token_end(source, index, "${") is not None:
            end, parameter_split = parameter_end(source, index, depth, quote == '"')
            current.append(source[index:end + 1])
            expanded_word = expanded_command = True
            may_split = may_split or quote is None or parameter_split
            index = end + 1
            continue
        if quote != "'" and character == "$":
            positional_end = logical_token_end(source, index, "$@")
            if positional_end is not None:
                current.append("$@")
                expanded_word = expanded_command = may_split = True
                index = positional_end
                continue
            parameter_start = index + 1
            while source[parameter_start:parameter_start + 2] == "\\\n":
                parameter_start += 2
            parameter = re.match(r"(?:[A-Za-z_][A-Za-z_0-9]*|[0-9*@#?$!-])", source[parameter_start:])
            if parameter:
                current.append("$" + parameter.group())
                expanded_word = expanded_command = True
                may_split = may_split or quote is None or parameter.group() == "@"
                index = parameter_start + len(parameter.group())
                continue
        if character == "=":
            literal_assignment = True
        if quote:
            if character == quote:
                quote = None
        elif character in {"'", '"'}:
            quote = character
        elif character in "*?[" or (
            character in "@+!" and logical_token_end(source, index + 1, "(") is not None
        ):
            expanded_word = expanded_command = True
            may_split = True
        elif character == "{" and (current or (
            source[index + 1:index + 2] and not source[index + 1].isspace()
        )):
            brace_depth += 1
            expanded_word = expanded_command = may_split = True
        elif character == "}" and brace_depth:
            brace_depth -= 1
            current.append(character)
            index += 1
            continue
        elif character == "#" and not current:
            emit_command()
            newline = source.find("\n", index)
            if newline < 0:
                break
            index = newline + 1
            continue
        elif character in "<>" or source[index:index + 2] == "&>":
            adjacent_word = bool(current)
            emit_word()
            if adjacent_word and words[-1][0].isdigit():
                words.pop()  # An unquoted adjacent IO number is not argv.
            end = index + 1
            while end < len(source) and source[end] in "<>&|":
                end += 1
            words.append((source[index:end], "", True))
            redirected = True
            index = end
            continue
        elif character in ";&|(){}\n":
            emit_command()
            index += 1
            continue
        elif character.isspace():
            emit_word()
            index += 1
            continue
        current.append(character)
        index += 1
    if quote:
        raise ValueError("unclosed quote in completion policy input")
    emit_command()
    return commands

def normalize_completion_command(source, depth=0):
    """Policy-only view: retain the whole command and add recognized child commands."""
    if depth > 8:
        raise ValueError("completion wrapper nesting exceeds safety limit")
    views = [source]
    for argv in completion_segments(source):
        child = completion_child_argv(argv)
        if child is not None:
            views.append(normalize_completion_command(shlex.join(child), depth + 1))
    return "\n".join(views)

def destructive_reason(source, depth=0):
    if depth > 8:
        return "shell nesting exceeds safety limit"
    if re.search(r":\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&", source):
        return "fork bomb definition is blocked"
    segments = shell_segments(source)
    if segments is None:
        return "unparseable shell command"
    for raw_argv in segments:
        argv = strip_command_prefix(raw_argv)
        if argv is None:
            return "unparseable command wrapper"
        if not argv:
            continue
        try:
            child = completion_child_argv(argv)
        except ValueError:
            return "invalid completion runner invocation"
        if child is not None:
            reason = destructive_reason(shlex.join(child), depth + 1)
            if reason:
                return reason
            continue
        executable = Path(argv[0]).name
        args = argv[1:]
        if executable in {"bash", "dash", "ksh", "sh", "zsh"}:
            for index, token in enumerate(args):
                if token == "-c" and index + 1 < len(args):
                    nested = destructive_reason(args[index + 1], depth + 1)
                    if nested:
                        return nested
            continue
        if executable == "eval":
            nested = destructive_reason(" ".join(args), depth + 1)
            if nested:
                return nested
            continue
        if executable.startswith("$"):
            return "unresolvable shell executable"
        if executable == "rm":
            if any(Path(token).name == "sudo" for token in raw_argv[:len(raw_argv) - len(argv)]):
                return "privileged removal"
            short_flags = "".join(token[1:] for token in args if token.startswith("-") and not token.startswith("--"))
            recursive = "r" in short_flags.lower() or "--recursive" in args
            force = "f" in short_flags.lower() or "--force" in args
            if recursive and force:
                return "recursive forced removal"
        elif executable == "find" and "-delete" in args:
            return "find delete"
        elif executable == "git":
            subcommand, subargs = git_subcommand(argv)
            short_flags = "".join(token[1:] for token in subargs if token.startswith("-") and not token.startswith("--"))
            if subcommand == "push" and ("f" in short_flags or any(token.startswith("--force") for token in subargs)):
                return "forced git push"
            if subcommand == "reset" and "--hard" in subargs:
                return "hard git reset"
            if subcommand == "clean":
                force = "f" in short_flags.lower() or "--force" in subargs
                directories = "d" in short_flags.lower() or "--directories" in subargs
                if force and directories:
                    return "forced git clean"
        elif executable == "docker" and len(args) >= 2 and args[0] in {"system", "image", "volume", "container", "network"} and args[1] == "prune":
            return "docker prune"
        elif executable == "chmod" and ("000" in args or ("777" in args and ("-R" in args or any(Path(arg).is_absolute() for arg in args)))):
            return "unsafe chmod"
    return ""


import json
import os
import shlex
import re
from pathlib import Path

payload = json.loads(os.environ["PAYLOAD"])
tool = str(payload.get("tool_name", ""))
tool_input = payload.get("tool_input", {}) or {}
write_tools = {"apply_patch", "Write", "Edit", "write_file", "edit_file"}
shell_tools = {"Bash", "shell", "exec_command"}
if tool not in write_tools | shell_tools:
    raise SystemExit(0)

start = Path(str(payload.get("cwd") or os.environ.get("WORKSPACE_BUILDER_PROJECT_ROOT") or os.getcwd())).resolve()
root = Path(os.environ.get("WORKSPACE_BUILDER_PROJECT_ROOT") or start).resolve()
while root != root.parent:
    if (root / ".codex" / "hooks.json").is_file() and not (root / ".codex" / "hooks.json").is_symlink():
        break
    root = root.parent

def deny(reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason, "additionalContext": reason}}, ensure_ascii=False))
    raise SystemExit(0)

if not (root / ".codex" / "hooks.json").is_file() or (root / ".codex" / "hooks.json").is_symlink():
    deny("Codex harness root cannot be resolved; tool use is blocked until the reviewed control plane is restored")

protected_files = {
    (root / ".codex" / "hooks.json").resolve(),
    (root / ".codex" / "config.toml").resolve(),
    (root / "AGENTS.md").resolve(),
    (root / "_meta" / "structure.json").resolve(),
    (root / "_meta" / "recovery-checks.sh").resolve(),
    (root / "_meta" / "recovery-state.py").resolve(),
    (root / "_meta" / "completion-check.py").resolve(),
    (root / "_meta" / "completion-result.json").resolve(),
    (root / "_meta" / "orchestration" / "POLICY.md").resolve(),
    (root / "_meta" / "orchestration" / "TEAM_PROGRESS.md").resolve(),
    (root / "_meta" / "orchestration" / "team_progress.py").resolve(),
}
protected_dirs = {
    (root / ".codex" / "hooks").resolve(),
    (root / ".codex" / "agents").resolve(),
    (root / "_meta" / "checks").resolve(),
}

def protected(path_text: str) -> bool:
    candidate = Path(path_text)
    if not candidate.is_absolute():
        candidate = start / candidate
    try:
        resolved = candidate.resolve()
        return resolved in protected_files or any(
            resolved == directory or directory in resolved.parents
            for directory in protected_dirs
        )
    except (OSError, RuntimeError):
        return True

def locator_values(value: object, key: str = "") -> list[str]:
    if isinstance(value, dict):
        values: list[str] = []
        for child_key, child_value in value.items():
            values.extend(locator_values(child_value, str(child_key).lower()))
        return values
    if isinstance(value, list):
        values = []
        for child_value in value:
            values.extend(locator_values(child_value, key))
        return values
    locator_terms = ("path", "file", "target", "dest", "output", "source")
    return [str(value)] if isinstance(value, str) and any(term in key for term in locator_terms) else []

def patch_paths(patch_text: str) -> list[str]:
    prefixes = ("*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: ")
    return [
        line.removeprefix(prefix).strip()
        for line in patch_text.splitlines()
        for prefix in prefixes
        if line.startswith(prefix)
    ]

if tool in write_tools:
    path_values = locator_values(tool_input)
    if tool == "apply_patch":
        patch_text = str(tool_input.get("patch") or tool_input.get("input") or tool_input.get("command") or "")
        path_values.extend(patch_paths(patch_text))
    if not path_values:
        deny("Unclassified structured write target is blocked by the Codex harness")
    should_deny = any(protected(value) for value in path_values)
else:
    command = str(tool_input.get("command") or tool_input.get("cmd") or "")
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        deny("Unparseable shell command is blocked by the Codex harness")
    try:
        completion_parts = completion_segments(command)
        invocations = [completion_invocation(part) for part in completion_parts]
    except ValueError:
        deny("Uninspectable completion runner invocation")
    if any(item is not None and item[0].startswith("module:") for item in invocations):
        deny("Use the reviewed completion-check.py file path; module resolution is not a trusted runner identity")
    invocation = invocations[0] if len(invocations) == 1 else None
    if invocation is not None:
        entry, child, details, action = invocation
        if any(c in command for c in "$\x60") or details.get("uninspectable_environment") or any(
            wrapper != "env" for wrapper in details.get("wrappers", [])
        ):
            deny("Completion runner wrapper cannot be inspected with a fixed working directory")
        checker = root / "_meta/completion-check.py"
        supplied = Path(entry)
        supplied = supplied if supplied.is_absolute() else start / supplied
        if supplied.resolve() != checker or not checker.is_file() or checker.is_symlink():
            deny("Completion runner must be the generated local file")
        import hashlib
        metadata = json.loads((root / "_meta/structure.json").read_text())
        expected = metadata.get("generation_options", {}).get("checker_sha256", {}).get("_meta/completion-check.py")
        if not expected or hashlib.sha256(checker.read_bytes()).hexdigest() != expected:
            deny("Completion runner integrity check failed")
        if action == "status":
            raise SystemExit(0)
        tokens = child
        command = shlex.join(tokens)
        start = root
    if len(tokens) >= 2 and tokens[0] == "python3" and not any(c in command for c in "$\x60;&|<>\n\r"):
        arguments = tokens[1:]
        if arguments[0] == "-B":
            arguments = arguments[1:]
        if arguments:
            supplied = Path(arguments[0])
            supplied = supplied if supplied.is_absolute() else start / supplied
            for relative in ("_meta/recovery-state.py", "_meta/checks/operations.py"):
                checker = root / relative
                remaining = arguments[1:]
                if relative.endswith("recovery-state.py"):
                    shape_ok = not remaining or (
                        len(remaining) == 1 and (start / remaining[0]).resolve() == root
                    )
                else:
                    shape_ok = not remaining or (
                        len(remaining) == 2 and remaining[0] == "--period"
                        and re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])", remaining[1]) is not None
                    )
                if shape_ok and supplied.resolve() == checker and checker.is_file() and not checker.is_symlink():
                    import hashlib
                    metadata = json.loads((root / "_meta/structure.json").read_text())
                    expected = metadata.get("generation_options", {}).get("checker_sha256", {}).get(relative)
                    if expected and hashlib.sha256(checker.read_bytes()).hexdigest() == expected:
                        raise SystemExit(0)
    # Only the unchanged generated helper may update intent state. This is not
    # permission to run arbitrary Python or mutate the helper/configuration.
    if len(tokens) in (3, 5) and tokens[0] == "python3" and not any(c in command for c in "$`;&|<>\n\r"):
        helper = root / "_meta/orchestration/team_progress.py"
        supplied = Path(tokens[1])
        supplied = supplied if supplied.is_absolute() else start / supplied
        action = tokens[2]
        shape_ok = (
            len(tokens) == 3 and action in {"count-pending", "list-pending"}
        ) or (
            len(tokens) == 5 and action in {"classify", "close"}
            and re.fullmatch(r"[0-9TZ:.\-]+", tokens[3]) is not None
        ) or (
            len(tokens) == 5 and action == "record"
            and re.fullmatch(r"[A-Za-z0-9_-]+", tokens[3]) is not None
            and tokens[4] in {"pending", "running", "done", "blocked", "cancelled"}
        )
        if shape_ok and supplied.resolve() == helper and helper.is_file() and not helper.is_symlink():
            import hashlib
            metadata = json.loads((root / "_meta/structure.json").read_text())
            expected = metadata.get("generation_options", {}).get("team_progress_sha256")
            if expected and hashlib.sha256(helper.read_bytes()).hexdigest() == expected:
                raise SystemExit(0)
    markers = (".codex/hooks", ".codex/config.toml", ".codex/agents", "AGENTS.md", "_meta/structure.json", "_meta/recovery-checks.sh", "_meta/recovery-state.py", "_meta/completion-check.py", "_meta/completion-result.json", "_meta/checks/", "_meta/orchestration/POLICY.md", "_meta/orchestration/TEAM_PROGRESS.md", "_meta/orchestration/team_progress.py")
    touches_control_plane = (
        any(marker in command for marker in markers)
        or (".codex" in command and "hooks.json" in command)
        or any(
        protected(token) for token in tokens if token not in {";", "&&", "||", "|", "&", ">", ">>", "<", "<<"}
        )
    )
    # Inline interpreter bodies cannot be confined by searching for path strings:
    # equivalent spellings or computed paths can write the protected control plane.
    # Reviewed file/module test commands remain available.
    segments = [[]]
    for token in tokens:
        if token in {";", "&&", "||", "|", "&", "\n"}:
            segments.append([])
        else:
            segments[-1].append(token)
    for segment in segments:
        while segment and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", segment[0]):
            segment = segment[1:]
        while segment and Path(segment[0]).name in {"env", "command", "builtin", "exec", "nohup", "sudo", "time"}:
            wrapper = Path(segment[0]).name
            segment = segment[1:]
            value_options = {"env": {"-u", "--unset", "-C", "--chdir"},
                             "sudo": {"-u", "-g", "-h", "-p", "-C", "-D", "-R"},
                             "exec": {"-a"}, "time": {"-f", "-o"}}
            while segment and segment[0].startswith("-"):
                if segment[0] == "--":
                    segment = segment[1:]
                    break
                segment = segment[2:] if segment[0] in value_options.get(wrapper, set()) else segment[1:]
            while segment and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", segment[0]):
                segment = segment[1:]
        if not segment:
            continue
        executable = Path(segment[0]).name
        if executable == "eval":
            deny("Unclassifiable inline evaluation is blocked; use a reviewed file/module command")
        if executable == "deno" and segment[1:2] == ["eval"]:
            deny("Inline interpreter code is blocked; use a reviewed file/module test command")
        is_python = re.fullmatch(r"python(?:3(?:\.\d+)?)?", executable) is not None
        shell = executable in {"bash", "sh", "zsh", "dash", "ksh"}
        inline = "c" if is_python or shell else {"node": "ep", "bun": "ep", "ruby": "e", "perl": "eE", "php": "r"}.get(executable, "")
        if not inline:
            continue
        arguments = segment[1:]
        value_options = {"-W", "-X"} if is_python else {"-o", "-O"} if shell else {"--input-type"}
        while arguments:
            argument = arguments[0]
            if argument in {"-m", "--"} or not argument.startswith("-"):
                break
            long_inline = executable in {"node", "bun"} and (argument in {"--eval", "--print"} or argument.startswith(("--eval=", "--print=")))
            if long_inline or (not argument.startswith("--") and any(flag in argument[1:] for flag in inline)):
                deny("Inline interpreter code is blocked; use a reviewed file/module test command")
            consumes_value = argument in value_options or (shell and not argument.startswith("--") and argument.endswith(("o", "O")))
            arguments = arguments[2:] if consumes_value else arguments[1:]
    if not touches_control_plane:
        raise SystemExit(0)
    safe_readers = {"[", "cat", "cd", "file", "find", "grep", "head", "less", "ls", "md5", "more", "pwd", "readlink", "realpath", "rg", "sed", "shasum", "sha256sum", "stat", "tail", "test", "wc"}
    command_names: list[str] = []
    expect_command = True
    for token in tokens:
        if token in {";", "&&", "||", "|", "&", "\n"}:
            expect_command = True
            continue
        if expect_command and "=" in token and not token.startswith("="):
            continue
        if expect_command:
            command_names.append(Path(token).name)
            expect_command = False
    unsafe_syntax = any(token in {">", ">>", "<<"} for token in tokens)
    unsafe_options = "-delete" in tokens or "-exec" in tokens or "-execdir" in tokens or any(
        token == "-i" or token.startswith("-i.") for token in tokens
    )
    should_deny = unsafe_syntax or unsafe_options or not command_names or any(
        name not in safe_readers for name in command_names
    )
if should_deny:
    deny("Codex harness control-plane files are immutable during the session; use read-only inspection or edit them between trusted sessions")
PY
