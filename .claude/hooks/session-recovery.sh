#!/usr/bin/env bash
# session-recovery.sh — SessionStart hook (workspace-builder R24, Recovery-First)
# 역할: 세션 시작 시 미커밋 변경(=복구 지점 없는 작업물)을 감지해 복구 컨텍스트를 주입한다.
# 조건 미충족 시 아무것도 출력하지 않음 — 상시 컨텍스트 비용 0.
set -uo pipefail
cat > /dev/null  # stdin 소비

DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE=""
if [ -f "$DIR/_meta/recovery-state.py" ]; then
  STATE=$(python3 -B "$DIR/_meta/recovery-state.py" "$DIR" 2>&1) || true
fi
cd "$DIR" 2>/dev/null || exit 0
UNCOMMITTED=0
if git rev-parse --git-dir > /dev/null 2>&1; then
  UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
fi
[ -n "$STATE" ] || [ "$UNCOMMITTED" -gt 0 ] || exit 0
python3 - "$STATE" "$UNCOMMITTED" <<'PY'
import json, sys
context = sys.argv[1]
if int(sys.argv[2]):
    context += f"\n[session-recovery] 미커밋 변경 {sys.argv[2]}건. git status와 _meta/recovery.md를 확인하고 필요한 작업을 이어가세요."
print(json.dumps({
    "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}
}, ensure_ascii=False))
PY

exit 0
