#!/usr/bin/env bash
# config-guard.sh — ConfigChange hook (workspace-builder R24, 메타 방어)
# 역할: 세션 중 hooks 설정 변경을 무효화한다 — 가드/리커버리 훅을 세션 안에서 끄는 우회 차단.
# 세션 밖에서 설정 파일을 직접 수정하는 것은 막지 않는다 (사용자 최종 권한 보존).
set -uo pipefail

INPUT=$(cat)
CHANGED=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(d.get("changed_fields",[]) or []))' 2>/dev/null || echo "")

case ",$CHANGED," in
  *,hooks,*)
    {
      echo "⛔ [config-guard] 세션 중 hooks 설정 변경 감지 — 무효화합니다."
      echo "가드/리커버리 훅은 이 워크스페이스의 기계 방어선입니다. 변경이 필요하면"
      echo "세션을 종료하고 설정 파일을 직접 수정한 뒤 새 세션에서 시작하세요."
    } >&2
    exit 2
    ;;
esac

exit 0
