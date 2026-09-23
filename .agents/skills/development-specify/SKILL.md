---
name: development-specify
description: "기능 명세 작성, subtype 변경, 요구사항 수정, 실패 조건 보완, 다시 정의 요청에 사용합니다. 'api 기능 명세 잡아줘', 'llm-app 기준으로 다시 정의해줘', '실패 조건 보완해줘' 같은 요청에 대응합니다. 단, 설계 상세화는 $development-design을 사용합니다."
---

# specify Workflow

Codex-compatible mirror of `specify.md` from the `development` archetype.

Invoke explicitly with `$development-specify` followed by the workflow arguments.
Claude per-command tool controls (for example `allowed-tools`) are not enforced by this skill; Codex sandbox and approval settings remain separate.

# $development-specify

기능의 subtype, 요구사항, 실패 조건, 완료 기준을 정의합니다.

## 사용법

```text
$development-specify [api|cli|llm-app|automation] [기능명]
```

## 실행 흐름

### Step 1: subtype 확정

- api, cli, llm-app, automation 중 하나를 선택합니다.
- subtype이 없으면 먼저 사용자 의도를 확인합니다.

### Step 2: 요구사항 정의

- 기능 요구사항, 비기능 요구사항, 입력, 출력, 제약, 실패 조건을 정리합니다.
- 기존 spec이 있으면 변경 요청인지 재작성인지 구분합니다.

### Step 3: Eval Harness 기준 정의

- `20-knowledge/frameworks/subtype-eval-harness.md`를 읽고 subtype별 완료 기준을 만듭니다.
- 평가 계획은 `10-planning/eval-plan.md`에 정의합니다. 실행 가능한 평가 코드·픽스처는 `evals/{subtype}/`에 둡니다.

### Step 4: 저장

- `10-planning/spec.md`에 저장합니다.
- 후속 커맨드로 `$development-design`을 안내합니다.

## 프레임워크 호출

- Step 3에서 `20-knowledge/frameworks/subtype-eval-harness.md`를 자동 적용합니다.
- 출력 산출물에 `## Subtype`과 `## 완료 기준` 섹션을 추가합니다.

## 출력 형식

```markdown
# 기능 명세: [기능명]

## Subtype

- type: api / cli / llm-app / automation

## 요구사항

- FR:
- NFR:

## 입력/출력

- 입력:
- 출력:
- 실패 조건:

## 완료 기준

- 테스트:
- eval:
```

## 트리거 경계

should-trigger:

- "기능 명세 작성해줘"
- "api 기준으로 spec 잡아줘"
- "llm-app으로 다시 정의해줘"
- "CLI 요구사항 보완해줘"
- "자동화 실패 조건 추가해줘"
- "완료 기준 다시 잡아줘"
- "eval 기준 넣어줘"
- "처음부터 다시 정의해줘"

NOT-trigger:

- "아키텍처 설계해줘" → `$development-design`
- "코드 구현해줘" → `$development-implement`
- "테스트 실행해줘" → `$development-test`
- "보안 리뷰해줘" → `$development-review`
