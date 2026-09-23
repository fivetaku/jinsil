#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
PAYLOAD_ROOT=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd", ""))' 2>/dev/null || true)
ROOT="${WORKSPACE_BUILDER_PROJECT_ROOT:-${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${PAYLOAD_ROOT:-$PWD}}}}"
while [ "$ROOT" != "/" ] && { [ ! -f "$ROOT/.codex/hooks.json" ] || [ -L "$ROOT/.codex/hooks.json" ] || [ -L "$ROOT/.codex" ]; }; do
  ROOT="$(dirname "$ROOT")"
done
[ "$ROOT" != "/" ] || { printf '%s\n' 'workspace harness root could not be resolved' >&2; exit 2; }
STATE=""
if [ -f "$ROOT/_meta/recovery-state.py" ]; then
  STATE=$(python3 -B "$ROOT/_meta/recovery-state.py" "$ROOT" 2>&1) || true
fi
cd "$ROOT" 2>/dev/null || exit 0
COUNT=0
if git rev-parse --git-dir >/dev/null 2>&1; then
  COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
fi
[ "$COUNT" -gt 0 ] || [ -n "$STATE" ] || exit 0
python3 - "$COUNT" "$STATE" <<'PY'
import json, sys
context = sys.argv[2]
if int(sys.argv[1]):
    context += f"\n[session-recovery] {sys.argv[1]} uncommitted changes have no recovery point. Inspect git status and _meta/recovery.md before continuing."
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}, ensure_ascii=False))
PY
