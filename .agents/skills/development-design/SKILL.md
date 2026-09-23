---
name: development-design
description: "모듈 설계, SOLID 경계 설정, subtype별 아키텍처 보완, API/CLI/LLM 흐름 재설계 요청에 사용합니다. '설계해줘', 'SOLID 기준으로 보완해줘', 'CLI 구조 다시 잡아줘' 같은 요청에 대응합니다. 단, 코드 작성은 $development-implement를 사용합니다."
---

# design Workflow

Codex-compatible mirror of `design.md` from the `development` archetype.

Invoke explicitly with `$development-design` followed by the workflow arguments.
Claude per-command tool controls (for example `allowed-tools`) are not enforced by this skill; Codex sandbox and approval settings remain separate.

# $development-design

spec을 기반으로 subtype별 아키텍처와 모듈 경계를 설계합니다.

## 사용법

```text
$development-design [기능명]
```

## 실행 흐름

### Step 1: spec 확인

- `10-planning/spec.md`를 읽고 subtype, 요구사항, 완료 기준을 확인합니다.
- spec이 없으면 `$development-specify`를 먼저 실행합니다.

### Step 2: 필요한 모듈 경계만 설계 (SOLID 참고)

먼저 한 파일이나 단순 함수 조합으로 요구사항을 충족할 수 있는지 확인합니다. 실제로 분리할 책임·교체할 구현·테스트 경계가 있을 때만 관련 SOLID 원칙을 적용합니다. 원칙 하나당 파일·인터페이스를 만드는 방식으로 구조를 늘리지 않습니다.

- **SRP** (Single Responsibility) — 한 모듈은 하나의 변경 이유를 가진다
- **OCP** (Open/Closed) — 새 subtype·provider 추가가 기존 코드를 크게 바꾸지 않게
- **LSP** (Liskov Substitution) — 교체 가능한 구현은 같은 계약을 지킨다
- **ISP** (Interface Segregation) — 호출자가 쓰지 않는 메서드에 의존하지 않게 인터페이스 분리
- **DIP** (Dependency Inversion) — 고수준 정책이 구체 구현이 아닌 추상 계약에 의존

`10-planning/architecture.md`에 선택한 구성과 분리 이유를 기록합니다. SOLID를 적용했다면 관련 원칙만 설명하며 미적용 원칙의 항목을 채우지 않습니다.

**품질 기준**:
- 기능 추가가 한 파일에 과도하게 몰림 → SRP 위반, 책임 분리
- 외부 의존성은 시험 가능한 경계로 구분하되, 교체 요구가 없는 단일 호출에 별도 인터페이스 계층을 강제하지 않습니다.
- 테스트가 어려운 설계 → 의존성 방향 재검토

### Step 3: subtype별 설계

- api: 엔드포인트, 요청/응답, 인증/인가, 오류 형식을 정의합니다.
- cli: 명령, 인자, 종료 코드, 표준 출력/오류를 정의합니다.
- llm-app: 프롬프트·eval 데이터·모델 경계를 정의합니다. 검색이 필요한 경우에만 RAG 흐름을 설계합니다.
- automation: dry-run, idempotency, 재시도, 로그를 정의합니다.

### Step 4: 저장

- `10-planning/architecture.md`, 필요 시 `30-docs/api.md`에 저장합니다.
- 후속 커맨드로 `$development-implement`를 안내합니다.

## 프레임워크 호출

- Step 2의 SOLID는 본 커맨드 본문에 인라인됨 (이전 `20-knowledge/frameworks/solid-principles.md` 격하, 2026-05-07).
- 실제 검색이 필요한 llm-app에만 `$development-implement`에서 이어 사용할 RAG 설계 포인트를 남깁니다.

## 출력 형식

```markdown
# 설계: [기능명]

## SOLID 설계 판단

- SRP:
- OCP:
- LSP:
- ISP:
- DIP:

## Subtype 설계

- subtype:
- 모듈:
- 인터페이스:
- 의존성:
```

## 트리거 경계

should-trigger:

- "아키텍처 설계해줘"
- "SOLID 기준으로 보완해줘"
- "API 설계 다시 잡아줘"
- "CLI 구조 설계해줘"
- "LLM 앱 흐름 그려줘"
- "자동화 재시도 구조 넣어줘"
- "모듈 경계 수정해줘"
- "이어서 설계 보완해줘"

NOT-trigger:

- "요구사항부터 정리해줘" → `$development-specify`
- "코드 작성해줘" → `$development-implement`
- "테스트 만들어줘" → `$development-test`
- "보안 취약점 봐줘" → `$development-review`
