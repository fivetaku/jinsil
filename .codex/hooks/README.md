# Codex Hooks

`.codex/hooks.json`이 이 디렉토리의 스크립트를 등록합니다. Codex는 처음 보는 프로젝트 훅을
실행하기 전에 trust 확인을 요구할 수 있습니다. 내용을 검토한 뒤 신뢰할 때만 승인하세요.



Codex 0.143+ stable hook surface의 지원 이벤트만 등록합니다. Claude 전용 `ConfigChange`는 PreToolUse 경로
가드로 대체합니다. Codex 0.144.1의 일반 shell/apply_patch `PostToolUse` payload에는 실패 상태가 없으므로
`PostToolUseFailure` 자동 복구 주입은 제공하지 않고 Stop/SessionStart recovery 계약으로 보완합니다.
