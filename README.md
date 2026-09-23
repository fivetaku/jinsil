# jinsil

> API, CLI, LLM 앱, 자동화 스크립트를 subtype별 평가 기준으로 설계, 구현, 테스트, 리뷰하는 개발 에이전트 워크스페이스입니다.

이 워크스페이스는 Workspace_Builder가 `Development Agent` 아키타입(structure.json v2.0.0)으로 생성했습니다.

## 시작

```bash
claude
# 또는
codex
```

이후 자연어로 작업을 요청하면 `.claude/commands/`의 Claude 커맨드, `.agents/skills/`의 Codex 스킬, 또는 각 instruction surface의 워크플로우로 라우팅됩니다.

## 문서

- [CLAUDE.md](./CLAUDE.md) — Claude Code instruction surface
- [AGENTS.md](./AGENTS.md) — Codex instruction surface
- [.agents/skills/](./.agents/skills/) — Codex repo skills
- [.codex/config.toml](./.codex/config.toml) — Codex project config
- [_meta/deviations.md](./_meta/deviations.md) — 템플릿 대비 일탈 기록
- [_meta/HARNESS_STATUS.md](./_meta/HARNESS_STATUS.md) — 훅 생성·등록과 실제 발동 증거의 구분

훅 상태 확인: `python3 -B _meta/harness-status.py`.
정적 점검 통과는 실제 활성화 증명이 아니며, 런타임 발동 확인 전에는 `unverified`입니다.
