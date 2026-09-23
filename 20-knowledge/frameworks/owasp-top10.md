# OWASP Top 10 — Golden Sample

> **출처**: `/tmp/harness-100/ko/16-fullstack-webapp/.claude/skills/api-security-checklist/skill.md` 및 `/tmp/harness-100/ko/28-security-audit/` 보안 감사 패턴 변환. 원본 자산은 Apache License 2.0 조건을 따릅니다.
>
> **버전**: v2.0 (2026-05-07) — `hook-patterns.md` Golden Sample의 7섹션 계약을 development 아키타입에 맞게 적용. `/review` 산출물의 보안 발견 사항을 OWASP Top 10 2021 기준으로 구조화합니다.

## 목적

이 문서는 Development Agent의 `/review` 단계에서 외부 입력, 인증, 인가, 데이터 접근, 의존성, 로그를 빠짐없이 점검하게 만드는 보안 리뷰 계약입니다.
일반적인 OWASP 소개가 아니라, 이 워크스페이스의 subtype, 파일 구조, 산출물 형식에 맞춘 검색 패턴과 판정 기준을 제공합니다.
리뷰어는 발견 사항을 `A01`~`A10`으로 매핑하고, 파일 위치·안티패턴·권장 코드·체크리스트 통과율을 함께 보고합니다.
수정 구현은 이 문서에서 직접 수행하지 않고 `/implement` 또는 `/test`로 넘깁니다.

## 호출 명세

| 호출자 | 호출 시점 | 산출물 변경 |
|---|---|---|
| `commands/review.md` Step 1 | 변경 파일, subtype, 외부 입력 경계 확인 | 리뷰 범위에 `api`, `webapp`, `cli`, `llm-app`, `automation` 보안 경계 표시 |
| `commands/review.md` Step 2 | OWASP 보안 점검 | `## 보안 검토 (OWASP Top 10 기준)` 섹션 추가 |
| `commands/review.md` Step 4 | Findings 정리 | 각 finding에 `OWASP`, `위치`, `안티패턴`, `권장`, `검증 체크리스트 결과` 포함 |
| `commands/specify.md` Step 2 | 인증·인가·외부 입력이 요구사항에 등장 | `10-planning/spec.md`의 비기능 요구사항에 보안 완료 기준 후보를 추가 |
| `commands/specify.md` Step 3 | subtype eval 기준 정의 | 보안 회귀 테스트 계획을 `10-planning/eval-plan.md` 후보로 연결. 실행 코드는 `evals/{subtype}/` |

---

## 1. 언제 적용

- `api` subtype에서 route, controller, resolver, handler가 외부 요청을 받는 경우
- 웹앱에서 쿠키, 세션, JWT, OAuth, 관리자 화면, 파일 업로드, 사용자 생성 콘텐츠를 다루는 경우
- `llm-app`에서 사용자 입력을 도구 호출, URL fetch, RAG 검색, 코드 실행, 외부 API 호출로 연결하는 경우
- `cli` 또는 `automation`이 파일 경로, 셸 명령, 환경변수, 외부 URL, 토큰을 입력으로 받는 경우
- 리뷰 요청에 "보안", "OWASP", "민감 정보", "인증", "인가", "Injection", "SSRF"가 포함된 경우
- 운영 전 `Full` scale 기능이거나 개인정보, 결제, 관리자 권한, 조직 데이터에 접근하는 경우

## 2. 언제 적용하지 않음

- **격리된 toy 코드** — 네트워크, 파일, 인증, 외부 입력이 없고 학습 목적의 단일 예제이면 간단한 위험 메모만 남깁니다.
- **일회성 로컬 스크립트** — 본인 로컬 파일만 처리하고 외부 입력·토큰·배포 경로가 없으면 `cli` 파일 안전성만 확인합니다.
- **학습용 알고리즘 풀이** — 정렬, 파싱, 자료구조처럼 보안 경계가 없는 코드는 subtype 완료 기준을 우선합니다.
- **문서·프롬프트만 수정** — 실행 경로나 데이터 접근이 바뀌지 않으면 OWASP 전항목 리뷰 대신 민감 정보 노출만 확인합니다.
- **이미 검증된 테스트 fixture** — 의도적으로 취약 문자열을 담은 테스트 데이터는 실제 코드 경로와 분리되어 있으면 finding으로 올리지 않습니다.
- **수정 구현 요청** — 취약점 수정 자체는 `/implement` 범위이며, 이 문서는 리뷰와 판정 기준만 제공합니다.

## 3. 선택 매트릭스

프로젝트 유형과 독자 기준으로 리뷰의 1순위·2순위 OWASP 항목을 먼저 확인합니다.

| 프로젝트 유형 | 독자 | 1순위 | 2순위 |
|---|---|---|---|
| API | 개발자 | A01 Broken Access Control | A03 Injection |
| API | 리뷰어 | A07 Auth Failures | A09 Logging Failures |
| 웹앱 | 개발자 | A03 Injection | A05 Security Misconfiguration |
| 웹앱 | 리뷰어 | A01 Broken Access Control | A02 Cryptographic Failures |
| CLI | 개발자 | A03 Injection | A08 Software/Data Integrity |
| CLI | 리뷰어 | A02 Cryptographic Failures | A06 Vulnerable Components |
| LLM 앱 | 개발자 | A10 SSRF | A08 Software/Data Integrity |
| LLM 앱 | 리뷰어 | A04 Insecure Design | A09 Logging Failures |

선택 절차:
1. `/review` Step 1에서 subtype과 외부 입력 경계를 먼저 확정합니다.
2. 위 표의 1순위 항목을 먼저 검색하고, 실제 코드 경로가 있으면 finding 후보로 올립니다.
3. 2순위 항목은 테스트·설정·로그·의존성까지 확장해서 확인합니다.
4. 표에 없는 항목도 grep 결과가 나오면 해당 OWASP 번호로 추가 분류합니다.
5. 각 finding은 "패턴 발견"이 아니라 "외부 입력에서 위험 sink까지 도달 가능"할 때만 필수 수정으로 올립니다.

---

## OWASP Top 10 (2021 기준)

### A01 Broken Access Control

- 정의: 인증된 사용자가 자기 권한 밖의 객체, 기능, 관리자 route에 접근할 수 있는 상태입니다.
- 검색: `grep -rE "params\\.(id|userId|orgId)|req\\.query\\.(id|userId|orgId)" src/`
- 검색: `grep -rE "admin|role|isAdmin|authorize|requireRole" src/`
- 점검: route마다 인증 미들웨어와 객체 소유권 검사가 같은 경로에 있는지 확인합니다.
- 안티패턴: `db.user.findUnique({ where: { id: req.params.userId } })`
- 좋은 코드: `db.user.findFirst({ where: { id: userId, orgId: currentUser.orgId } })`

### A02 Cryptographic Failures

- 정의: 비밀, 토큰, 개인정보, 비밀번호가 약한 암호화·평문 저장·부적절한 전송으로 노출되는 상태입니다.
- 검색: `grep -rE "(password|secret|token|apiKey).*=.*['\\\"]" src/ config/`
- 검색: `grep -rE "md5|sha1|createCipher|http://" src/ config/`
- 점검: 비밀번호는 bcrypt/argon2, 토큰은 환경변수, 민감 데이터는 로그·응답에서 제거됐는지 확인합니다.
- 안티패턴: `const jwtSecret = "dev-secret"`
- 좋은 코드: `const jwtSecret = requiredEnv("JWT_SECRET")`

### A03 Injection

- 정의: 사용자 입력이 SQL, 셸, 템플릿, 브라우저, 프롬프트, 쿼리 언어로 그대로 들어가는 상태입니다.
- 검색: `grep -rE "exec\\(|eval\\(|Function\\(|raw\\(|query\\(" src/ scripts/`
- 검색: `grep -rE "\\$\\{.*(req|input|params|query|body)" src/`
- 점검: source가 `req.body`, `argv`, LLM 출력, URL parameter이면 parameterized query나 allowlist가 있는지 봅니다.
- 안티패턴: `db.query(\`SELECT * FROM users WHERE id=${userId}\`)`
- 좋은 코드: `db.query("SELECT * FROM users WHERE id=$1", [userId])`

### A04 Insecure Design

- 정의: 코드 한 줄의 버그가 아니라 요구사항·상태 전이·신뢰 경계 설계에 보안 통제가 빠진 상태입니다.
- 검색: `grep -rE "TODO.*(auth|security|rate|validate)|skipAuth|bypass" 10-planning/ 30-docs/ src/`
- 검색: `grep -rE "status|state|workflow|approve|admin" src/ 10-planning/ 30-docs/`
- 점검: spec에 실패 조건, 권한 모델, rate limit, 상태 전이 불변식이 있는지 확인합니다.
- 안티패턴: `if (body.status === "approved") order.status = "approved"`
- 좋은 코드: `transitionOrder(order, "approve", currentUser)`

### A05 Security Misconfiguration

- 정의: 개발 설정, CORS, 디버그, 에러 응답, 보안 헤더, 기본 계정이 운영 경로에 남은 상태입니다.
- 검색: `grep -rE "NODE_ENV|DEBUG|cors\\(|origin:\\s*['\\\"]\\*|stack" src/ config/`
- 검색: `grep -rE "helmet|csrf|sameSite|secure|httpOnly" src/ config/`
- 점검: 프로덕션에서 스택 trace, wildcard CORS+credentials, debug route, 기본 비밀번호가 없는지 확인합니다.
- 안티패턴: `app.use(cors({ origin: "*", credentials: true }))`
- 좋은 코드: `app.use(cors({ origin: allowedOrigins, credentials: true }))`

### A06 Vulnerable Components

- 정의: 취약한 라이브러리, 런타임, 베이스 이미지, 플러그인, lockfile이 실제 실행 경로에 포함된 상태입니다.
- 검색: `grep -rE "\"(express|next|fastify|axios|lodash)\"" package.json`
- 검색: `grep -rE "FROM node:|FROM python:|apt-get install" Dockerfile*`
- 점검: `npm audit`, `pip-audit`, `trivy`, lockfile 변경 여부와 CVSS Critical/High의 도달 가능성을 확인합니다.
- 안티패턴: `FROM node:16`
- 좋은 코드: `FROM node:20-bookworm-slim`

### A07 Auth Failures

- 정의: 로그인, 세션, JWT, 비밀번호 재설정, refresh token, MFA 흐름이 우회되거나 약한 상태입니다.
- 검색: `grep -rE "login|logout|refresh|jwt|session|cookie|resetPassword" src/`
- 검색: `grep -rE "expiresIn|maxAge|sameSite|httpOnly|secure|bcrypt|argon2" src/`
- 점검: 로그인 rate limit, 토큰 만료, 쿠키 보안 속성, 로그아웃 무효화, 계정 열거 방지를 확인합니다.
- 안티패턴: `res.cookie("token", token)`
- 좋은 코드: `res.cookie("token", token, { httpOnly: true, secure: true, sameSite: "lax" })`

### A08 Software and Data Integrity Failures

- 정의: 업데이트, webhook, 플러그인, 직렬화 데이터, LLM/tool 출력의 무결성을 검증하지 않는 상태입니다.
- 검색: `grep -rE "webhook|signature|deserialize|pickle|yaml.load|JSON.parse" src/ scripts/`
- 검색: `grep -rE "npm install|curl .*\\| sh|download|plugin|toolCall" src/ scripts/ 30-docs/`
- 점검: webhook 서명, 패키지 고정, 체크섬, 역직렬화 allowlist, LLM 도구 호출 승인 경계를 확인합니다.
- 안티패턴: `const event = JSON.parse(req.body)`
- 좋은 코드: `const event = verifyWebhookSignature(req.rawBody, req.headers)`

### A09 Security Logging and Monitoring Failures

- 정의: 보안 이벤트가 남지 않거나, 남더라도 민감 정보가 그대로 기록되어 탐지와 대응이 불가능한 상태입니다.
- 검색: `grep -rE "console\\.log|logger\\.|audit|login failed|forbidden|unauthorized" src/`
- 검색: `grep -rE "(password|token|authorization|cookie)" src/`
- 점검: 인증 실패, 권한 거부, 관리자 변경, webhook 실패는 audit log로 남기되 token·password는 마스킹합니다.
- 안티패턴: `logger.info("login failed", req.body)`
- 좋은 코드: `audit.warn("login_failed", { emailHash, ip, reason })`

### A10 Server-Side Request Forgery

- 정의: 사용자가 준 URL을 서버가 fetch하여 내부망, 메타데이터, 로컬 파일, 관리 포트에 접근할 수 있는 상태입니다.
- 검색: `grep -rE "fetch\\(|axios\\.|request\\(|got\\(|new URL" src/`
- 검색: `grep -rE "url|callback|webhook|avatar|import|crawl|scrape" src/`
- 점검: scheme allowlist, DNS 재해석 방지, 내부 IP 차단, redirect 제한, timeout이 있는지 확인합니다.
- 안티패턴: `const html = await fetch(req.body.url)`
- 좋은 코드: `const html = await safeFetch(req.body.url, { allowHosts, blockPrivateIp: true })`

---

## 4. 좋은 예 vs 나쁜 예 (3쌍)

### 쌍 1 — API 객체 접근

**나쁜 예** (A01):
```ts
router.get("/users/:id", async (req, res) => res.json(await users.get(req.params.id)));
```

**좋은 예**:
```ts
router.get("/users/:id", requireAuth, async (req, res) => res.json(await users.getOwned(req.params.id, req.user.orgId)));
```

차이: 나쁜 예는 인증된 사용자라면 아무 `id`나 조회할 수 있고, 좋은 예는 현재 조직 소유권을 쿼리 조건에 포함합니다.

### 쌍 2 — 검색 API 쿼리

**나쁜 예** (A03):
```ts
await db.query(`SELECT * FROM docs WHERE title LIKE '%${req.query.q}%'`);
```

**좋은 예**:
```ts
await db.query("SELECT * FROM docs WHERE title ILIKE $1", [`%${q}%`]);
```

차이: 나쁜 예는 입력이 SQL 문자열에 합쳐지고, 좋은 예는 검증된 `q`를 파라미터로 전달합니다.

### 쌍 3 — LLM 앱 URL fetch

**나쁜 예** (A10):
```ts
const page = await fetch(toolArgs.url).then(r => r.text());
```

**좋은 예**:
```ts
const page = await safeFetch(toolArgs.url, { allowHosts: ["docs.example.com"], timeoutMs: 3000 });
```

차이: 나쁜 예는 모델 출력이 곧 서버 요청이 되고, 좋은 예는 host allowlist와 timeout으로 도구 경계를 고정합니다.

---

## 5. 산출물 diff (확장 전/후)

이 framework가 적용되면 `/review` 산출물은 모호한 보안 메모가 아니라 OWASP 번호, 위치, 안티패턴, 권장 코드, 체크리스트 결과를 포함해야 합니다.

**확장 전** (framework 미적용 가정):
```markdown
## 보안 검토
SQL Injection 가능성 있음. 수정 권장.
```

**확장 후** (framework 적용 후):
```markdown
## 보안 검토 (OWASP Top 10 기준)
- A03 Injection: src/api/users.ts:42 — 사용자 입력 raw query 인터폴레이션
  - 안티패턴: `query(...interpolated...)`
  - 권장: parameterized query — `query("SELECT * FROM users WHERE id=$1", [userId])`
- A07 Auth Failures: src/api/admin/*.ts — 인증 미들웨어 없음 (모든 admin route)
- A09 Logging Failures: src/auth/login.ts:31 — 로그인 실패 로그에 req.body 전체 기록
- 검증 체크리스트 결과: 9/14 통과 (5건 필수 수정)
```

`/review`의 Findings에는 심각도 순서를 적용합니다.
Critical/High는 실제 외부 입력 경로와 민감 자산 영향이 함께 확인된 경우에만 부여합니다.
패턴만 발견되고 exploit 경로가 불명확하면 `확인 필요`로 두고 테스트 또는 설계 근거를 요청합니다.

---

## 6. 검증 체크리스트 (`/review` 단계 적용)

리뷰어는 다음 항목을 yes/no로 판정하고, 통과 수를 `/review` 산출물에 기록합니다.

- [ ] 1. 모든 API route에서 인증 미들웨어가 명시적으로 적용됐는가
- [ ] 2. 사용자 소유 리소스 접근에 `userId` 또는 `orgId` 소유권 조건이 포함됐는가
- [ ] 3. 관리자 route가 role 또는 permission 미들웨어를 통과하는가
- [ ] 4. 사용자 입력이 SQL/NoSQL 쿼리에 직접 인터폴레이션되는 곳이 0건인가
- [ ] 5. `exec`, `eval`, `Function`, shell 실행에 사용자 입력이 직접 들어가는 곳이 0건인가
- [ ] 6. 비밀(API key, JWT secret, token)이 코드/리포에 하드코딩된 곳이 0건인가 (`grep -rE "(secret|key|token).*=.*['\\\"]"`)
- [ ] 7. 비밀번호 저장 또는 검증에 bcrypt/argon2 등 안전한 해시가 사용되는가
- [ ] 8. JWT/session/cookie에 만료, `httpOnly`, `secure`, `sameSite` 중 필요한 속성이 설정됐는가
- [ ] 9. 프로덕션 CORS가 wildcard origin과 credentials를 동시에 허용하지 않는가
- [ ] 10. 외부 URL fetch가 allowlist, 내부 IP 차단, timeout, redirect 제한을 갖는가
- [ ] 11. 파일 경로 입력이 `path.resolve`와 허용 디렉터리 검사를 통과하는가
- [ ] 12. webhook, plugin, tool call, 다운로드 결과에 서명·체크섬·스키마 검증 중 하나가 적용됐는가
- [ ] 13. 로그인 실패, 권한 거부, 관리자 변경, webhook 실패가 audit log로 남는가
- [ ] 14. 로그와 에러 응답에 password, token, authorization header, cookie, 개인정보 원문이 남지 않는가

판정 기준:
- 14/14 통과: OWASP 리뷰 통과
- 11~13/14 통과: 보완 권고, High 이상 finding이 없으면 merge 가능
- 8~10/14 통과: 필수 수정 후보 존재, `/implement`로 넘김
- 7 이하: 보안 경계 재설계 필요, `/specify` 또는 `/design`부터 재검토

---

## 다른 framework와의 관계

- **`solid-principles.md`** — OWASP가 "무엇이 위험한가"를 찾으면 SOLID는 "어디에 책임을 둬야 고칠 수 있는가"를 결정합니다. 인증/인가가 handler마다 흩어져 있으면 A01 finding과 함께 SRP/DIP 위반도 확인합니다.
- **`subtype-eval-harness.md`** — OWASP finding은 재발 방지 테스트로 닫습니다. API는 통합 테스트, CLI는 악성 입력 fixture, LLM 앱은 tool-call eval, automation은 dry-run/권한 fixture로 연결합니다.
- **`rag-chunking.md`** — LLM 앱에서 RAG 문서와 외부 URL fetch가 결합되면 A08/A10을 우선합니다. 검색 품질 문제와 보안 경계 문제를 분리해서 보고합니다.

## 변경 이력

| 날짜 | 변경 | 사유 |
|---|---|---|
| 2026-05-06 | 최초 도입 (45줄, API 보안 체크리스트 변환) | Development 아키타입 보안 리뷰 기준 추가 |
| 2026-05-07 | Golden Sample v2.0 — 7섹션 계약 적용, 선택 매트릭스, OWASP Top 10 2021 항목별 grep 패턴, 좋은 예/나쁜 예, `/review` 산출물 diff, 14항목 검증 체크리스트 추가 | Council 권고 반영: 일반 설명 대신 이 워크스페이스의 실제 리뷰 절차와 산출물 변화 강화 |
