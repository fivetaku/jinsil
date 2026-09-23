# jinsil — 클진요 (클로드에게 진실을 요구합니다)

Claude 구독 한도 1%가 실제로 얼마인지 참여자 PC에서 측정하고, 계산값만 모아 요금제별 가성비를 공개하는 프로젝트. 정본 PRD: `~/ideation-workspace/50-blueprints/claude-quota-ledger/PRD/`.

| 경로 | 내용 |
|---|---|
| `cli/` | npm `jinsil` — 로컬 기록기(프록시)·헤더 틱 구간 계산·setup/claude/status/report/submit/uninstall. 런타임 의존성 0 |
| `server/` | Cloudflare Workers + D1 — 기기 코드 연결, Google 로그인, 제출 검증·비용 재계산, 가성비·순위·스티커, 웹 페이지 |
| `scripts/` | `e2e-run.mjs`(실제 계정 로컬 E2E), `e2e-check.mjs` |
| `docs/` | 스크린샷(`screens/`), E2E 기록 |

```sh
npm install                       # 루트(워크스페이스). wrangler는 server 개발 의존성
npm test --workspaces             # cli + server
node cli/test/verify-local.mjs    # 기록기 회귀 25개
npm run test:interval && npm run test:web && npm run screenshots
node scripts/e2e-run.mjs && npm run e2e:check   # 실제 구독 사용량 소모
cd server && npm run dev          # 로컬 서버 (.dev.vars.example 참고)
```

## 운영 (2026-09-23 배포)

- 웹: https://jinsil.axwith.com — Cloudflare Workers `jinsil` + D1 `jinsil`(커스텀 도메인, 일일 cron `17 3 * * *`).
- Google 로그인: GCP 프로젝트 `jinsil`의 웹 클라이언트 `jinsil-web`(프로덕션 게시, 범위 `openid`만). 비밀값은 `wrangler secret`의 `GOOGLE_CLIENT_SECRET`.
- 설치: `npx jinsil setup` (npm 게시자 `gptaku`).
- 재배포: `cd server && env -u CLOUDFLARE_API_TOKEN npx wrangler deploy` (wrangler OAuth 로그인 계정 기준).

---

> 아래는 Workspace_Builder 생성 안내: API, CLI, LLM 앱, 자동화 스크립트를 subtype별 평가 기준으로 설계, 구현, 테스트, 리뷰하는 개발 에이전트 워크스페이스입니다.

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
