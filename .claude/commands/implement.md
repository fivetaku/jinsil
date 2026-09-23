---
description: "코드 구현, 부분 수정, 버그 수정, LLM 통합 보완, 이어서 구현 요청에 사용합니다. '구현해줘', '버그 고쳐줘', 'RAG 통합 보완해줘' 같은 요청에 대응합니다. 단, 검증 실행은 /test를 사용합니다."
---

# /implement

설계 문서를 기준으로 subtype별 코드를 구현합니다.

## 사용법

```text
/implement [기능명]
```

## 실행 흐름

### Step 1: 설계와 테스트 기준 확인

- `10-planning/spec.md`, `10-planning/architecture.md`, `evals/{subtype}/`를 확인합니다.
- 구현 범위가 spec 밖이면 먼저 `/specify` 또는 `/design`으로 넘깁니다.

### Step 2: subtype별 구현

- api: 라우트, 핸들러, 서비스, 스키마, 오류 형식을 구현합니다.
- cli: 명령 진입점, 인자 파서, 출력 포맷, 종료 코드를 구현합니다.
- automation: dry-run, 재시도, 로그, idempotency 처리를 구현합니다.

### Step 3: 검색이 필요한 LLM 앱에만 RAG 적용

- llm-app 중 실제 검색/검색증강이 필요한 경우에만 `20-knowledge/frameworks/rag-chunking.md`를 적용합니다. 검색 없는 호출·분류·변환 앱에 벡터 DB나 청킹을 추가하지 않습니다.
- `prompts/`와 `evals/llm-app/`를 함께 갱신합니다.

### Step 4: 저장

- 코드는 `src/`, 프롬프트는 `prompts/`, 자동화는 `scripts/`에 저장합니다.
- 후속 커맨드로 `/test`를 안내합니다.

## 프레임워크 호출

- Step 3에서 검색이 요구되는 llm-app에만 RAG 프레임워크를 적용합니다.
- RAG를 사용한 경우에만 청킹 방식·오버랩·메타데이터 정책을 기록합니다.

## 출력 형식

```markdown
# 구현 결과

## 변경 파일

- src/...

## Subtype 처리

- subtype:
- 구현 범위:

## 후속 검증

- /test:
- /review:
```

## 트리거 경계

should-trigger:

- "구현해줘"
- "코드 작성해줘"
- "버그 고쳐줘"
- "부분 수정해줘"
- "RAG 통합 보완해줘"
- "프롬프트 파일 추가해줘"
- "자동화 스크립트 작성해줘"
- "이어서 구현해줘"

NOT-trigger:

- "기능 명세부터 잡아줘" → `/specify`
- "설계 다시 해줘" → `/design`
- "테스트 실행해줘" → `/test`
- "보안 리뷰해줘" → `/review`
