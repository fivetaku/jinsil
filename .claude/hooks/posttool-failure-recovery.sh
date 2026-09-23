#!/usr/bin/env bash
# posttool-failure-recovery.sh — PostToolUseFailure hook (workspace-builder R24)
# 역할: 도구 호출이 실패한 순간 recovery 계약의 존재를 상기시킨다 (실패를 무시한 강행 방지).
# 비차단 — additionalContext만 주입.
set -uo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_name",""))' 2>/dev/null || echo "")

python3 - "$TOOL" <<'PYEOF'
import json, sys
tool = sys.argv[1] if len(sys.argv) > 1 else ""
print(json.dumps({
    "additionalContext": (
        f"[recovery] 도구({tool}) 실패. 같은 방식으로 즉시 재시도하지 마세요. "
        "_meta/recovery.md의 실패 루프(멈춤→상태 파악→기록→되돌리기/수습→재발 방지)와 "
        "재시도 한계(같은 작업 3회)를 따르세요."
    )
}, ensure_ascii=False))
PYEOF

exit 0
