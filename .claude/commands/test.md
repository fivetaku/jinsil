---
description: "테스트 작성, eval harness 실행, 실패 재현, 커버리지 보완, 다시 실행 요청에 사용합니다. '테스트 추가해줘', 'eval 돌려줘', '실패 재현해줘' 같은 요청에 대응합니다. 단, 보안 리뷰는 /review를 사용합니다."
---

# /test

subtype별 테스트와 eval harness를 작성하고 실행합니다.

## 사용법

```text
/test [기능명]
/test [기능명] --type [unit|integration|e2e|eval]
```

## 실행 흐름

### Step 1: 완료 기준 확인

- `10-planning/spec.md`의 완료 기준과 `evals/{subtype}/`를 읽습니다.
- 구현이 없으면 `/implement`를 먼저 실행합니다.

### Step 2: Subtype Eval Harness 적용

- `20-knowledge/frameworks/subtype-eval-harness.md`를 읽고 subtype별 테스트를 만듭니다.
- api, cli, llm-app, automation별 통과 기준을 분리합니다.

### Step 3: 테스트 실행

- 가능한 경우 실제 테스트 명령을 실행합니다.
- 실행은 `python3 _meta/completion-check.py run -- 실제명령 인자...`를 사용합니다.
  종료 코드와 코드/테스트 입력 해시가 `_meta/completion-result.json`에 기록됩니다.
  명령은 이 프로젝트의 실제 테스트여야 하며 통과를 꾸미는 대체 명령을 쓰지 않습니다.
- 실행할 수 없으면 이유와 수동 검증 항목을 기록합니다.
- 검사를 못 했을 때 pass 결과를 만들지 않습니다. 보고서만 작성해도 기계 검증은 통과하지 않습니다.

### Step 4: 결과 반영

- 테스트 코드와 픽스처는 `tests/`, `evals/`에 유지하고 결과 보고서는 `40-reports/test-results.md`에 저장합니다.
- subtype별 평가 보고서는 `40-reports/evals/{subtype}.md`에 저장합니다. 실행 명령·종료 코드·실패 사례를 포함합니다.
- 실패 케이스는 재현 단계와 예상/실제 결과를 남깁니다.
- 후속 수정은 `/implement`, 기준 변경은 `/specify`로 넘깁니다.
- `--recovery` 생성물의 Stop은 이 검사 결과를 읽습니다. 미검증·실패·검사 후 코드 변경은 완료 차단 대상입니다.

## 프레임워크 호출

- Step 2에서 `20-knowledge/frameworks/subtype-eval-harness.md`를 자동 적용합니다.
- 출력 산출물에 `## subtype별 테스트 결과` 섹션을 추가합니다.

## 출력 형식

```markdown
# 테스트 결과

## 요약

- subtype:
- 총:
- 통과:
- 실패:

## subtype별 테스트 결과

- api:
- cli:
- llm-app:
- automation:

## 실패 케이스

- 재현:
- 예상:
- 실제:
```

## 트리거 경계

should-trigger:

- "테스트 추가해줘"
- "eval harness 만들어줘"
- "eval 돌려줘"
- "실패 재현해줘"
- "커버리지 보완해줘"
- "다시 실행해줘"
- "LLM 앱 회귀 테스트해줘"
- "CLI 종료 코드 검증해줘"

NOT-trigger:

- "명세 수정해줘" → `/specify`
- "설계 보완해줘" → `/design`
- "버그 고쳐줘" → `/implement`
- "OWASP 리뷰해줘" → `/review`
