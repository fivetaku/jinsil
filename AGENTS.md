# Development Agent

> API, CLI, LLM 앱, 자동화 스크립트를 subtype별 평가 기준으로 설계, 구현, 테스트, 리뷰하는 개발 에이전트 워크스페이스입니다.

**target runtime**: Codex (AGENTS.md 기준). 정본 instruction surface는 `CLAUDE.md`.

---

## 운영 규칙 (포인터)

- 이 워크스페이스의 정체성·원칙·워크플로우·커맨드·품질 규칙은 **`CLAUDE.md` 전문을 그대로 적용**한다.
  Codex는 이 파일을 읽은 뒤 반드시 `CLAUDE.md`를 읽고 따른다.
- 규칙 수정은 `CLAUDE.md`에만 한다. 이 파일에는 규칙을 추가하지 않는다 (두 surface 간 drift 방지).
- `CLAUDE.md`의 Claude Code 전용 표현은 Codex 등가물로 읽는다:
  `.claude/commands/{name}.md` 커맨드 → `.agents/skills/` repo skill,
  `Task 위임`/`.claude/agents/*.md` → `.codex/agents/*.toml`.

## Codex Runtime Notes

- Command-style workflows are mirrored as repo skills under `.agents/skills/`.
- Invoke a mirrored `/command` as `$<archetype>-<command> <arguments>` using its SKILL.md name; Claude argument macros are not native Codex substitutions.
- Skill agents/openai.yaml controls implicit invocation only; Claude per-command tool controls are not equivalent to Codex sandbox or approval settings.
- Project-local Codex settings live in `.codex/config.toml`.
- Runtime-ready custom agents live in `.codex/agents/*.toml` and are registered in `.codex/config.toml`.
- The stable spawn tool does not inject a registered role automatically; delegation messages must require the child to read its role TOML first.
- Project hooks live in `.codex/hooks.json` and run only after project hook trust approval.
