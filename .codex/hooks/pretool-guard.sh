#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); i=d.get("tool_input",{}) or {}; print(i.get("command") or i.get("cmd") or "")' 2>/dev/null || true)
[ -z "$CMD" ] && exit 0
normalize_completion_input() {
CMD="$CMD" python3 <<'PY'
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


try:
    print(normalize_completion_command(os.environ["CMD"]))
except ValueError:
    import sys
    print("WB_POLICY_DENY", file=sys.stderr)
    print("completion invocation cannot be inspected safely", file=sys.stderr)
    raise SystemExit(2)
PY
}
NORMALIZE_STATUS=0
CMD=$(normalize_completion_input) || NORMALIZE_STATUS=$?
[ "$NORMALIZE_STATUS" -eq 0 ] || exit "$NORMALIZE_STATUS"

deny() {
  python3 - "$1" <<'PY'
import json, sys
reason = sys.argv[1]
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason, "additionalContext": reason}}, ensure_ascii=False))
PY
}
check_destructive_command() {
CMD="$CMD" python3 <<'PY'
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


command = os.environ.get("CMD", "")
reason = destructive_reason(command)
if reason:
    print(reason)
PY
}

MATCH=$(check_destructive_command)
if [ -n "$MATCH" ]; then
  deny "pretool guard blocked irreversible command: $MATCH"
  exit 0
fi
BLOCK_PATTERNS=(
  'rm[[:space:]]+-[^[:space:]]*[rR][^[:space:]]*[fF]'
  'rm[[:space:]]+-[^[:space:]]*[fF][^[:space:]]*[rR]'
  'rm[[:space:]]+-[^[:space:]]*[rR][^[:space:]]*[[:space:]]+-[^[:space:]]*[fF]'
  'rm[[:space:]]+-[^[:space:]]*[fF][^[:space:]]*[[:space:]]+-[^[:space:]]*[rR]'
  'rm[[:space:]]+--recursive[[:space:]]+--force'
  'rm[[:space:]]+--force[[:space:]]+--recursive'
  'git[[:space:]]+push[[:space:]]+.*--force'
  'git[[:space:]]+reset[[:space:]]+--hard'
  'git[[:space:]]+clean[[:space:]]+-[^[:space:]]*[fF][^[:space:]]*[dD]'
  'git[[:space:]]+clean[[:space:]]+-[^[:space:]]*[dD][^[:space:]]*[fF]'
  'find[[:space:]]+.*-delete'
  'npm publish'
  'wrangler deploy'
  'wrangler secret put'
  'git push'
)
for PATTERN in "${BLOCK_PATTERNS[@]}"; do
  if printf '%s' "$CMD" | grep -qE "$PATTERN"; then
    deny "pretool guard blocked irreversible command; perform it outside the agent session after review"
    exit 0
  fi
done
if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])git([[:space:]]+(-[cC][[:space:]]+[^[:space:]]+|--[^[:space:]]+))*[[:space:]]+(commit|add)([[:space:]]|$)'; then
PAYLOAD_ROOT=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd", ""))' 2>/dev/null || true)
ROOT="${WORKSPACE_BUILDER_PROJECT_ROOT:-${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${PAYLOAD_ROOT:-$PWD}}}}"
while [ "$ROOT" != "/" ] && { [ ! -f "$ROOT/.codex/hooks.json" ] || [ -L "$ROOT/.codex/hooks.json" ] || [ -L "$ROOT/.codex" ]; }; do
  ROOT="$(dirname "$ROOT")"
done
[ "$ROOT" != "/" ] || { printf '%s\n' 'workspace harness root could not be resolved' >&2; exit 2; }
  PII=$(cd "$ROOT" && { git -c core.quotePath=false diff --cached --name-only; git -c core.quotePath=false status --porcelain | sed 's/^...//'; } 2>/dev/null | grep -iE '\.(pem|key|p12)$|secret|credential|password|통장|계좌|주민|신분증|이력서|계약서|동의서|개인정보' | sort -u | head -10 || true)
  if [ -n "$PII" ]; then
    deny "pretool guard blocked git history write because PII or secret-like paths are present: $PII"
  fi
fi
