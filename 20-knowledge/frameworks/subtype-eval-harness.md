# 서브타입 평가 하네스 — Golden Sample

> **출처**: `/tmp/harness-100/ko/41-llm-app-builder/`, `/tmp/harness-100/ko/40-cli-tool-builder/`, `/tmp/harness-100/ko/18-api-designer/`, `/tmp/harness-100/ko/24-test-automation/`의 평가·테스트 패턴을 Development 아키타입에 맞게 재구성했습니다. 원본 자산은 Apache License 2.0 조건을 따릅니다.
>
> **버전**: v2.0 (2026-05-07) — `hook-patterns.md` Golden Sample의 7섹션 계약 적용. Codex Round 2 권고에 따라 OWASP/SOLID 일반론이 아니라 subtype별 "완료 증명" 평가 하네스를 차별화 자산으로 강화합니다.

## 목적

서브타입 평가 하네스는 `api`, `cli`, `llm-app`, `automation`이 서로 다른 방식으로 "완료"를 증명하도록 만드는 개발 검증 계약입니다.
같은 테스트 통과라도 API는 계약 일치와 p95 지연시간, CLI는 종료 코드와 stdout 골든, LLM 앱은 프롬프트 회귀와 토큰 비용, 자동화는 멱등성과 롤백으로 증명합니다.
이 문서는 `/specify`에서 완료 기준을 만들고 `/test`에서 실행 가능한 하네스로 변환할 때 사용합니다.

## 호출 명세

| 호출자 | 호출 시점 | 산출물 변경 |
|---|---|---|
| `commands/specify.md` Step 3 | subtype별 완료 기준 정의 | `10-planning/spec.md`에 `## 완료 기준`, `10-planning/eval-plan.md` 초안 추가 |
| `commands/test.md` Step 2 | subtype별 테스트 또는 eval 작성 | `tests/`, `evals/{subtype}/`, fixtures, golden file, 실행 명령 추가 |
| `commands/test.md` Step 4 | 결과 반영 | `40-reports/evals/{subtype}.md`에 subtype 전용 지표와 체크리스트 통과율 기록 |

---

## 적용 강도

아래 항목은 평가 설계의 후보 목록이지 모든 작업의 고정 할당량이 아닙니다. 실제 요구사항·실패 비용·데이터·예산을 근거로 적용 항목과 합격선을 정합니다. 예시의 반복 횟수·토큰 수·지연시간을 근거 없이 필수값으로 복사하지 않습니다. 선택하지 않은 기능의 검사는 해당 없음으로 기록합니다.

## 1. 언제 적용

- `/specify api|cli|llm-app|automation`으로 기능 subtype이 선언된 경우
- `/test`에서 테스트 추가, eval harness 작성, 완료 기준 검증을 요청받은 경우
- 구현 완료 여부를 일반 unit test가 아니라 사용자 관점의 완료 증명으로 확인해야 하는 경우
- LLM 앱에서 프롬프트, 모델, RAG 설정, 출력 스키마, 토큰 예산 중 하나라도 바뀐 경우
- CLI가 실제 바이너리, stdin/stdout, 종료 코드, help 문구를 사용자 계약으로 제공하는 경우
- API가 스키마, 인증, 에러 형식, rate limit, 부하 기준을 갖는 경우
- 자동화 스크립트가 파일, 배포, 외부 API, 데이터 마이그레이션처럼 되돌리기 어려운 변경을 수행하는 경우

## 2. 언제 적용하지 않음

- **격리된 toy 코드** — 외부 입력, 사용자 계약, 반복 실행 요구가 없는 학습용 함수는 단위 테스트만으로 충분합니다.
- **개인 학습용 실험** — 버려질 가능성이 큰 스파이크 코드는 완료 증명 대신 관찰 메모를 남깁니다.
- **문서만 수정** — 실행 경로나 평가 지표가 바뀌지 않으면 문서 리뷰만 수행합니다.
- **subtype 미정 상태** — subtype이 없으면 먼저 `/specify`로 분류합니다.
- **의도적 수동 검증 작업** — 배포 승인, 법무 검토처럼 자동화할 수 없는 판단은 별도 수동 항목으로 분리합니다.
- **외부 서비스가 완전히 통제 불가한 경우** — 실제 호출 대신 목 서버, fixture, replay를 만들고 한계를 기록합니다.

## 3. subtype 매트릭스

| subtype | 핵심 평가 | 차별화된 도구 | "완료 증명" 형식 |
|---|---|---|---|
| API | 계약 일치 + 인증 + 부하 | OpenAPI/Pact + k6/wrk | 200/4xx/5xx 분포 + p95 latency |
| CLI | 인자 파싱 + 종료 코드 | Bats/expect + golden file | exit code 매트릭스 + stdout 골든 |
| LLM 앱 | 프롬프트 회귀 + 비결정성 | snapshot test + temp=0 / seed | 프롬프트 입력→출력 골든 + 토큰 회귀 |
| 자동화 | 멱등성 + 롤백 | dry-run + cleanup hook | 2회 실행 시 동일 상태 + 롤백 검증 |

선택 절차: `/specify`에서 subtype을 하나만 확정하고, 위 표의 "완료 증명"을 `10-planning/spec.md`와 `10-planning/eval-plan.md`로 옮깁니다.
여러 subtype이 섞이면 사용자-facing 계약을 기준으로 1차 subtype을 정하고, 보조 subtype은 추가 하네스로 둡니다.

---

## 4. API subtype eval harness

API의 완료 증명은 엔드포인트 실행이 아니라 스키마, 인증 실패, 오류 형식, 부하 한계가 모두 계약과 일치한다는 기록입니다.
`evals/api/`에는 `openapi.yaml`, 계약 테스트, 통합 테스트 fixture, 부하 테스트 스크립트를 둡니다. 사람이 읽는 결과 리포트는 `40-reports/evals/api.md`에 저장합니다.

### 통합 테스트

```ts
import request from "supertest";
import { app } from "../src/app";

describe("POST /v1/orders", () => {
  it("유효한 요청은 201과 주문 식별자를 반환한다", async () => {
    const res = await request(app).post("/v1/orders").set("Authorization", "Bearer valid-token").send({ sku: "book-1", quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^ord_/);
  });
  it("토큰 없음은 401, 권한 부족은 403이다", async () => {
    await request(app).post("/v1/orders").send({ sku: "book-1" }).expect(401);
    await request(app).post("/v1/orders").set("Authorization", "Bearer readonly-token").send({ sku: "book-1", quantity: 1 }).expect(403);
  });
});
```

### 계약 테스트

```ts
import { matchers } from "@pact-foundation/pact";
import { provider } from "./pact/provider";

await provider.addInteraction({
  state: "재고가 있는 상품",
  uponReceiving: "주문 생성 요청",
  withRequest: { method: "POST", path: "/v1/orders", body: { sku: "book-1", quantity: 2 } },
  willRespondWith: {
    status: 201,
    body: { id: matchers.regex("ord_123", "ord_[a-z0-9]+"), status: "created" }
  }
});
```

### 부하 테스트

```js
import http from "k6/http";
import { check } from "k6";

export const options = {
  stages: [{ duration: "1m", target: 10 }, { duration: "5m", target: 50 }],
  thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<300"] }
};

export default function () {
  const res = http.get(`${__ENV.API_BASE_URL}/v1/orders`, { headers: { Authorization: `Bearer ${__ENV.API_TOKEN}` } });
  check(res, { "상태 코드는 200": (r) => r.status === 200 });
}
```

API 결과 리포트는 `200/4xx/5xx` 분포, 스키마 위반 건수, 인증 실패 케이스, p95 지연시간, 에러율을 포함합니다.

## 5. CLI subtype eval harness

CLI의 완료 증명은 실제 바이너리 실행 결과가 사용자 계약과 일치한다는 것입니다.
`evals/cli/`에는 명령 매트릭스, golden stdout/stderr, 종료 코드 표, `--help` snapshot을 둡니다.

```bash
#!/usr/bin/env bats

@test "정상 입력은 종료 코드 0과 stdout JSON을 만든다" {
  run ./bin/worktool convert --input fixtures/input.json --json
  [ "$status" -eq 0 ]
  diff <(printf "%s\n" "$output") fixtures/golden/convert.stdout.json
}

@test "잘못된 옵션은 종료 코드 2와 stderr 도움말을 만든다" {
  run ./bin/worktool convert --unknown
  [ "$status" -eq 2 ]
  [ "$output" = "" ]
  ./bin/worktool convert --unknown 2>stderr.txt || true
  grep -q "알 수 없는 옵션" stderr.txt
}
@test "모든 subcommand의 help 형식이 일관된다" {
  for cmd in convert validate publish; do
    run ./bin/worktool "$cmd" --help; [ "$status" -eq 0 ]; [[ "$output" =~ "사용법:" ]]; [[ "$output" =~ "예시:" ]]
  done
}
```

CLI 결과 리포트는 명령별 exit code, stdout golden 통과 여부, stderr 오염 여부, stdin/pipe 호환성, help 일관성을 포함합니다.

## 6. LLM 앱 subtype eval harness

LLM 앱은 가장 차별화가 큰 영역입니다. 완료 증명은 답변이 그럴듯하다는 감상이 아니라 같은 입력에 안정적인 출력이 나오고, 프롬프트 변경이 snapshot diff로 드러나며, 출력 스키마와 토큰 예산이 자동 검증된다는 것입니다.
`evals/llm-app/`에는 prompt fixture, golden 출력, 스키마, 토큰 예산, judge 결과, 실행 로그를 둡니다.

```python
# 비결정성 점검 (temp=0 / seed 고정 / N회 실행)
def test_prompt_stability(prompt, n=5):
    outputs = [call_llm(prompt, temperature=0, seed=42) for _ in range(n)]
    assert all(o == outputs[0] for o in outputs), "비결정성 발견"

# 프롬프트 회귀 (snapshot)
def test_prompt_snapshot(prompt, golden_file):
    output = call_llm(prompt, temperature=0, seed=42)
    assert output == load_golden(golden_file)

# 토큰 비용 회귀
def test_token_budget(prompt, max_input_tokens=2000, max_output_tokens=500):
    response = call_llm(prompt)
    assert response.input_tokens <= max_input_tokens
    assert response.output_tokens <= max_output_tokens

# 출력 스키마 검증
def test_output_schema(prompt, schema):
    output = call_llm_json(prompt, temperature=0, seed=42)
    validate(instance=output, schema=schema)
```

LLM 앱 결과 리포트는 prompt snapshot 통과 수, 동일 입력 N회 안정성, 출력 스키마 위반, 입력/출력 토큰 예산, 평균 지연시간을 포함합니다.
RAG가 포함되면 `rag-chunking.md`의 Recall@K, 근거 문서 누락, 환각률을 별도 하위 지표로 연결합니다.

## 7. 자동화 스크립트 subtype eval harness

자동화의 완료 증명은 한 번 실행이 아니라 두 번 실행해도 같은 상태이고, dry-run이 실제 변경과 같은 계획을 보여주며, 실패 시 정리와 롤백이 검증된다는 것입니다. `evals/automation/`에는 sandbox fixture, dry-run snapshot, 실행 전후 상태 해시, cleanup hook, rollback 로그를 둡니다.

```bash
#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
cp -R fixtures/project/. "$fixture_dir"

before="$(find "$fixture_dir" -type f -print0 | sort -z | xargs -0 shasum)"
./scripts/migrate.sh --root "$fixture_dir" --dry-run > dry-run.txt
grep -q "변경 예정" dry-run.txt
./scripts/migrate.sh --root "$fixture_dir"
after_first="$(find "$fixture_dir" -type f -print0 | sort -z | xargs -0 shasum)"
./scripts/migrate.sh --root "$fixture_dir"
after_second="$(find "$fixture_dir" -type f -print0 | sort -z | xargs -0 shasum)"
test "$after_first" = "$after_second"
./scripts/migrate.sh --root "$fixture_dir" --rollback
after_rollback="$(find "$fixture_dir" -type f -print0 | sort -z | xargs -0 shasum)"
test "$before" = "$after_rollback"
```

자동화 결과 리포트는 dry-run 계획, 1회 실행 후 상태, 2회 실행 후 상태, rollback 후 상태, cleanup 성공 여부를 포함합니다.

---

## 8. 좋은 예 vs 나쁜 예 (3쌍)

### 쌍 1 — API 완료 기준
**나쁜 예**: "API 테스트 통과. 주문 생성 가능."
**좋은 예**: "계약 테스트 18/18 통과, 인증 실패 6/6 통과, 상태 코드 분포 2xx 97.8% / 4xx 2.1% / 5xx 0.1%, p95 241ms."
차이: 나쁜 예는 동작 여부만 말하고, 좋은 예는 계약·인증·부하 기준으로 완료를 증명합니다.

### 쌍 2 — CLI 완료 기준
**나쁜 예**: "명령어 실행됨. help도 보임."
**좋은 예**: "exit code 매트릭스 통과, stdout 골든 9/9 통과, stderr 오염 0건, 4개 subcommand help 형식 일치."
차이: 나쁜 예는 개발자 실행 감상이고, 좋은 예는 사용자가 의존하는 CLI 계약을 검증합니다.

### 쌍 3 — LLM 앱 완료 기준
**나쁜 예**: "요약 품질 괜찮음. 답변도 자연스러움."
**좋은 예**: "프롬프트 snapshot 12/13 통과, 비결정성 점검 5/5회 동일, 출력 스키마 13/13 통과, 토큰 회귀 입력 1842/2000·출력 487/500."
차이: 나쁜 예는 주관 평가이고, 좋은 예는 프롬프트 회귀·안정성·스키마·비용을 수치로 증명합니다.

## 9. 산출물 diff (`/test` 산출물 변화)

**확장 전**:
```markdown
## 테스트 결과
unit 23/25 통과, integration 8/8 통과.
```

**확장 후** (LLM 앱 subtype):
```markdown
## 테스트 결과 (subtype: LLM 앱)
- 프롬프트 snapshot: 12/13 통과 (1건 회귀 — `prompts/summary.txt:18`)
- 비결정성 점검: 5/5 회 동일 (temp=0, seed=42)
- 토큰 회귀: 입력 1842/2000 ✓, 출력 487/500 ✓
- 검증 체크리스트: 11/13 통과 (2건 미달 — #11 snapshot diff 자동화 누락, #12 토큰 회귀 측정 누락)
```

API라면 상태 코드 분포와 p95 지연시간, CLI라면 exit code 매트릭스와 stdout/stderr golden, 자동화라면 dry-run, 2회 실행 상태 해시, rollback 결과가 들어갑니다.

## 10. 검증 체크리스트 (`/specify`, `/test` 단계 적용)

공통:
- [ ] 1. 모든 의존성이 lockfile로 고정됐는가
- [ ] 2. test 실행이 CI에서 < 5분인가

API:
- [ ] 3. OpenAPI/Pact 스펙과 실제 응답이 자동 비교되는가
- [ ] 4. 인증 실패 케이스(401/403)가 테스트에 포함됐는가
- [ ] 5. p95 latency 임계치 위반 시 fail되는가
- [ ] 6. 부하 테스트가 정기 실행되는가

CLI:
- [ ] 7. exit code별 시나리오가 명시됐는가
- [ ] 8. golden file이 stdout/stderr 분리 검증하는가
- [ ] 9. `--help`가 모든 subcommand에서 일관되는가

LLM 앱:
- [ ] 10. temperature=0 + seed 고정 환경에서 실행되는가
- [ ] 11. 프롬프트 변경 시 snapshot diff가 자동 생성되는가
- [ ] 12. 토큰 회귀(입력+출력)가 측정되는가
- [ ] 13. 비결정성 신호(같은 입력 다른 출력)가 fail로 기록되는가

자동화:
- [ ] 14. dry-run 모드가 모든 변경 작업에 있는가
- [ ] 15. 2회 실행해도 같은 상태인가(idempotent)
- [ ] 16. 롤백 절차가 테스트에 포함됐는가

판정 기준:
- 실제 의존성과 실행 환경이 있는 범위에서 공통 기준을 적용하며, 미합의 예시 수치로 완료를 막지 않습니다.
- 선택 subtype 항목 중 2개 이상 실패하면 `/test`에서 하네스를 보강합니다.
- LLM 앱은 합의한 출력 계약·품질·비용 기준에 실패하면 완료 처리하지 않습니다. 자유서술의 문구 차이 자체를 실패로 보지 않으며, 구조화된 값이나 독립 평가 기준으로 판정합니다.
- 자동화의 14~16 중 하나라도 실패하면 운영 실행하지 않습니다.

---

## 다른 framework와의 관계

- **`owasp-top10.md`** — OWASP는 위험을 찾고, 이 문서는 위험이 재발하지 않도록 subtype별 회귀 테스트로 닫습니다.
- **`solid-principles.md`** — SOLID는 테스트 가능한 경계를 설계하게 하고, 이 문서는 그 경계가 사용자 계약으로 검증되는지 확인합니다.
- **`rag-chunking.md`** — LLM 앱에서 RAG가 포함되면 프롬프트 snapshot만으로 완료 처리하지 않고 검색 품질과 근거 문서 연결을 하위 지표로 묶습니다.

## 변경 이력

| 날짜 | 변경 | 사유 |
|---|---|---|
| 2026-05-06 | 최초 도입 (62줄, subtype별 기준 요약) | Development 아키타입 eval 기준 추가 |
| 2026-05-07 | Golden Sample v2.0 — 7섹션 계약 적용, subtype 매트릭스, API/CLI/LLM 앱/자동화별 코드 하네스, 좋은 예/나쁜 예, `/test` 산출물 diff, 16항목 검증 체크리스트 추가 | Codex Round 2 권고 반영: OWASP/SOLID 일반론이 아닌 subtype별 완료 증명 자산 강화 |
