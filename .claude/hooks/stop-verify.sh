#!/usr/bin/env bash
# stop-verify.sh — Stop hook (workspace-builder R24, Recovery-First)
# 역할: _meta/recovery-checks.sh(있을 때)를 실행해 실패하면 Claude의 응답 종료를 차단(exit 2)하고
#       recovery.md 실패 루프를 따르도록 지시한다. "검증 안 된 완료 선언" 방지.
# 루프 가드: stop_hook_active=true면 즉시 통과 (정지 차단 1회 후 재차단 금지 — 무한 루프 방지).
set -uo pipefail

INPUT=$(cat)
ACTIVE=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("stop_hook_active", False)).lower())' 2>/dev/null || echo "false")
[ "$ACTIVE" = "true" ] && exit 0

DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if ! STATE=$(python3 -B "$DIR/_meta/recovery-state.py" "$DIR" 2>&1); then
  printf '%s\n' "$STATE" >&2
  exit 2
fi
CHECKS="$DIR/_meta/recovery-checks.sh"

if [ -x "$CHECKS" ]; then
  if ! OUT=$(bash "$CHECKS" 2>&1); then
    {
      echo "⛔ [stop-verify] 검증 스크립트 실패 — 완료로 선언할 수 없는 상태입니다."
      echo "$OUT" | head -10
      echo "_meta/recovery.md의 '실패 루프'를 따르세요: ① 멈춤 ② 상태 파악 ③ 영향 기록 ④ 되돌리기/수습 ⑤ 재발 방지."
      echo "검증을 통과시킨 뒤 다시 종료하거나, 3회 실패 시 사용자에게 보고하세요."
    } >&2
    exit 2
  fi
fi

exit 0
