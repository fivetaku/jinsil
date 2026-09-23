#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
ACTIVE=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("stop_hook_active", False)).lower())' 2>/dev/null || echo false)
[ "$ACTIVE" = "true" ] && exit 0
PAYLOAD_ROOT=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd", ""))' 2>/dev/null || true)
ROOT="${WORKSPACE_BUILDER_PROJECT_ROOT:-${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${PAYLOAD_ROOT:-$PWD}}}}"
while [ "$ROOT" != "/" ] && { [ ! -f "$ROOT/.codex/hooks.json" ] || [ -L "$ROOT/.codex/hooks.json" ] || [ -L "$ROOT/.codex" ]; }; do
  ROOT="$(dirname "$ROOT")"
done
[ "$ROOT" != "/" ] || { printf '%s\n' 'workspace harness root could not be resolved' >&2; exit 2; }
if ! STATE=$(python3 -B "$ROOT/_meta/recovery-state.py" "$ROOT" 2>&1); then
    python3 - "$STATE" <<'PY'
import json, sys
print(json.dumps({"decision": "block", "reason": sys.argv[1]}, ensure_ascii=False))
PY
    exit 0
fi
CHECKS="$ROOT/_meta/recovery-checks.sh"
[ -x "$CHECKS" ] || exit 0
if ! OUTPUT=$(bash "$CHECKS" 2>&1); then
  python3 - "$OUTPUT" <<'PY'
import json, sys
reason = "Recovery verification failed. Follow _meta/recovery.md before completion: " + sys.argv[1][:500]
print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
PY
fi
