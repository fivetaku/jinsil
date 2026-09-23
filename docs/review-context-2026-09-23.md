# 검토용 현재 상태 정리 (2026-09-23)

클진요(jinsil): Claude 구독(Pro $20 · Max 5x $100 · Max 20x $200 · Team Standard $25 · Team Premium $125, 미국 월 결제) 한도 게이지 1%가 API 정가로 얼마인지 참여자 PC에서 계산하고, 계산값만 서버(Cloudflare Workers + D1, https://jinsil.axwith.com)로 보내 요금제별 "가성비 배수 = 주간 100% 환산 × 4.35주 ÷ 월 구독료"를 공개한다. 목적은 구독 한도 이의제기 근거 수집. 원칙: 프롬프트·응답 본문·인증값·이메일 비전송, 모르는 값은 0·추정으로 채우지 않음, CLI 런타임 의존성 0.

## 현재 구현 (배포됨, npm jinsil 0.1.5)
- 측정: 로컬 리버스 프록시 `cli/src/recorder.mjs`(127.0.0.1:10199, launchd/systemd 상주)를 Claude Code 요청 경로에 둔다. 경로 주입은 셸 별칭(`jinsil claude`, setup이 `claude -p`로 셸 설정을 분석해 claude 관련 alias를 감쌈, `cli/src/aiplan.mjs`, `cli/src/shell.mjs`).
- 장부: SSE usage(input/output/cache_read/cache_write_5m/1h)와 응답 헤더 `anthropic-ratelimit-unified-5h/7d-utilization`(0~1, 1%p 해상도)·reset.
- 구간: `cli/src/interval.mjs` — 같은 계정·같은 창에서 정수% 틱 사이(5h ≥3%p, 7d ≥1%p) 토큰 합 → 서버가 단가로 비용 재계산(`server/src/intervals.js`), 계정별 Σ비용/Σ%p로 집계(`server/src/stats.js accountStats`), 계정당 한 표·IQR 3배 이상치 제외·신규 계정 24시간 보류·요금제별 5계정 이상일 때 공개.
- 단가: `server/src/pricing.js` — LiteLLM model_prices_and_context_window.json(MIT)에서 Anthropic 항목만 일 1회 동기화(±50% 급변 보류). 실제 파일 대조 결과 현재 단가와 일치.

## 오늘 실측으로 확인한 사실
1. 게이지 반영 지연: 같은 계정에서 대용량 캐시 쓰기 요청 동안 게이지가 6→8%에 머물다가, 수십 초 뒤 작은 요청 2개 사이에 10→17%로 뜀. 3%p 구간별 1%당 값이 $0.02~$1.48(70배+)로 변동. 5시간 창 전체 합산은 계정·창 무관하게 $0.51~0.65/1%로 안정(4개 창, 각 Δ 36~98%p).
2. teamclaude(다계정 풀 프록시) 요청 로그 가져오기: 요청 로그가 일부 요청을 남기지 않음(동일 기간 TSV 대비 캐시 읽기 63~83%, 출력 17~53%만 포함). "구간 내 모든 요청이 로그에 있는" 구간만 골랐더니 짧은 구간 위주가 선택돼 주간 $231/100%로 과소 — 같은 계정 긴 창 TSV 합산은 $729~$1,116/100%, teamclaude 자체 표시($127 @15%)와 일치. 해당 30구간 삭제함.
3. 프록시 경로 주입의 문제: 사용자마다 alias·함수·라우터(ANTHROPIC_BASE_URL)·Paseo(SDK)·데스크톱 앱이 제각각. 참여자 1명(0.1.4)은 연결 후 제출 0건(평소 `claude`를 감싸지 않은 버전 추정, 미확인).
4. `~/.claude/settings.json`의 env.ANTHROPIC_BASE_URL은 셸 환경변수보다 우선, `--settings` 플래그는 settings.json보다 우선(가짜 서버 실험).
5. Claude Code 대화 파일 `~/.claude/projects/**/*.jsonl`에 assistant 메시지별 usage(input, output, cache_read, cache_creation.ephemeral_5m/1h, iterations, speed, inference_geo), message.id, model, timestamp, entrypoint(cli / sdk-cli)가 있음. 같은 message.id가 여러 줄 반복. 최근 7일 이 PC: Anthropic 직결 모델 42k줄, 라우터·타사 모델 38k줄.
6. usage API `GET /api/oauth/usage` → `{five_hour:{utilization:int, resets_at}, seven_day:{...}}`. 3초 간격 폴링은 429, 5분 간격 정상. 과거 재현: 폴링 1~15분이면 5시간 100% 환산 $55.7~59.3로 안정, 60분은 $73.6으로 왜곡.
7. 오픈소스 ai-token-monitor(soulduse)는 요청 경로 무개입: 대화 파일 감시(message_id:request_id 중복 제거, 파일 오프셋 증분) + usage API 5분 폴링(키체인 "Claude Code-credentials"에서 claudeAiOauth 토큰, 여러 계정 항목 후보 시도, 만료 시 `claude auth status`로 Claude Code가 갱신). 게이지↔토큰 역산은 하지 않음.
8. 같은 PC 재연결 시 기기가 중복 등록되던 문제는 서버에서 수정(같은 사용자·호스트·OS면 이전 연결 해제).

## 재설계안 (검토 대상)
A. 측정 원천 전환(기본): 요청 경로 무개입. 대화 파일 증분 읽기 + usage API 5분 폴링(최근 30분 사용 있을 때만). 프록시·별칭은 `--proxy` 옵션(다계정 풀 사용자·요청 단위 정밀도)으로만.
B. 집계 단위 전환: 3%p 틱 구간 폐기 → 한도 창 단위. 창(계정·게이지·resets_at)마다 Σ정가환산비용 ÷ Δ게이지(창 시작 샘플→최신 샘플). 최소 Δ: 5h 20%p, 7d 5%p. 창마다 결정적 id로 upsert(진행 중 갱신, 창 종료 시 확정).
C. 대화 파일 파싱: iterations 합산, 5m/1h 내역 없는 캐시쓰기는 unknown(추정 금지), speed=fast·서버 도구 요금은 별도 표시·제외, 라우터·타사 모델 제외.

## 알려진 한계·미결
- 다계정 풀(teamclaude 등): 대화 파일에는 계정이 없어 귀속 불가 → 게이지 계정(키체인 로그인 계정)과 불일치. 프록시 모드 필요.
- claude.ai 웹·앱 채팅은 같은 한도를 쓰지만 보이지 않음 → 1%당 가치 과소.
- 대화 파일의 timestamp가 응답 시작인지 완료인지, 데스크톱 앱 Code가 같은 폴더에 쓰는지 미확인.
- Team 좌석의 rate_limit_tier 문자열 미실측(현재 'team' 포함이면 Team으로 가르는 가정).
- 가성비 배수의 4.35주 vs 코드의 30/7 불일치 여부 점검 필요.
- 공개 기준: 요금제별 5계정, 신규 계정 24시간 보류, 주간 최소 데이터.
