# Template Deviation Log

이 파일은 워크스페이스가 `20-archetypes/development` 템플릿과 어떻게 다른지를 기록합니다.
Quick Path 생성에서는 "기본 템플릿 유지"가 기본 기록이고,
Custom Path에서는 사용자가 명시적으로 동의한 변경 사항만 기록합니다.

## Reflected Harness Metadata (생성 시점)

| 항목 | 값 | 출처 |
|------|----|------|
| target runtime | Claude Code + Codex (CLAUDE.md + AGENTS.md) | Workspace_Builder |
| harness_type | basic | 18-HARNESS_CONCEPTS.md |
| state_model | enabled=True, path=_meta | _meta 위치 |
| doctor_checks | structure, instructions, commands, security, harness-contract | validator 권장 묶음 |

## Deviation Table

| 날짜 | 아키타입 | 일탈 사유 | 영향 |
|------|----------|-----------|------|
| 2026-09-23 | development | 기본 템플릿 유지 (structure.json v2.0.0, generator MVP+harness-metadata) | 영향 없음 |
| 2026-09-23 | 코드 루트를 `src/` 대신 npm workspaces `cli/`·`server/`로 | cli, server | CLI(npm 게시 단위)와 Workers(배포 단위)가 독립 패키지여야 함. PRD 04_PROJECT_SPEC 저장소 구조 |
