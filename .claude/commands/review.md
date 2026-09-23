---
description: "코드 리뷰, 보안 점검, OWASP 검토, SOLID 위반 확인, RAG 품질 점검, 다시 리뷰 요청에 사용합니다. '리뷰해줘', 'OWASP 기준으로 봐줘', 'RAG 품질 확인해줘' 같은 요청에 대응합니다. 단, 수정 구현은 /implement를 사용합니다."
---

# /review

구현 결과를 코드 품질, 보안, 설계, subtype 완료 기준으로 리뷰합니다.

## 사용법

```text
/review [기능명]
/review --all
```

## 실행 흐름

### Step 1: 대상 확인

- 변경 파일, spec, design, test 결과를 확인합니다.
- subtype과 외부 입력 경계를 파악합니다.

### Step 2: OWASP 보안 점검

- `20-knowledge/frameworks/owasp-top10.md`를 읽고 인증, 인가, 입력 검증, Rate Limit, 외부 API, 민감 정보를 확인합니다.
- api subtype과 외부 입력이 있는 기능은 반드시 점검합니다.

### Step 3: SOLID와 RAG 품질 점검

- 실제 모듈·인터페이스 설계가 있는 부분에 SOLID를 적용합니다. 작은 단일 함수/스크립트에서는 정확성·경계·중복을 검토하며 불필요한 클래스·레이어를 만들지 않습니다. 적용되지 않는 원칙은 생략합니다.
- 검색을 사용하는 llm-app에만 `20-knowledge/frameworks/rag-chunking.md`의 청킹·메타데이터·검색 평가를 확인합니다.

### Step 4: 결과 정리

- 검토 결과를 `40-reports/review.md`에 저장합니다. 코드를 임의로 수정하지 않습니다.
- Findings를 심각도 순으로 정리합니다.
- 수정은 `/implement`, 테스트 보강은 `/test`, 명세 변경은 `/specify`로 넘깁니다.

## 프레임워크 호출

- Step 2에서 `20-knowledge/frameworks/owasp-top10.md`를 자동 적용합니다.
- Step 3의 적용 가능한 SOLID 기준과, 검색을 사용하는 경우에만 RAG 기준을 적용합니다.
- 출력 산출물에 `## OWASP 점검`, `## SOLID 점검`, `## subtype 완료 기준` 섹션을 추가합니다.

## 출력 형식

```markdown
# 리뷰 결과

## Findings

- [HIGH] 항목:
- [MED] 항목:
- [LOW] 항목:

## OWASP 점검

- 인증:
- 인가:
- 입력 검증:

## SOLID 점검

- 책임:
- 의존성:

## subtype 완료 기준

- 통과:
- 보완:
```

## 트리거 경계

should-trigger:

- "리뷰해줘"
- "OWASP 기준으로 봐줘"
- "보안 점검해줘"
- "SOLID 위반 찾아줘"
- "RAG 품질 확인해줘"
- "민감 정보 노출 확인해줘"
- "다시 리뷰해줘"
- "테스트 공백 찾아줘"

NOT-trigger:

- "명세 다시 써줘" → `/specify`
- "설계 다시 잡아줘" → `/design`
- "코드 고쳐줘" → `/implement`
- "테스트 실행해줘" → `/test`
