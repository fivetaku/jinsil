# RAG Chunking Framework — Golden Sample

> **출처**: `/tmp/harness-100/ko/41-llm-app-builder/.claude/skills/chunking-strategy-guide/skill.md` 변환 + Workspace_Builder Development 아키타입용 일반화. 원본 자산은 Apache License 2.0 조건을 따릅니다.
>
> **버전**: v2.0 (2026-05-07) — `hook-patterns.md` Golden Sample의 7섹션 계약 적용. Codex Round 3 권고에 따라 chunk size, overlap, metadata, retrieval eval을 LLM 앱 subtype의 차별화 자산으로 강화합니다.

## 목적

RAG 파이프라인에서 chunking은 문서 전처리가 아니라 **검색 가능한 근거 단위의 계약**입니다.
`llm-app` subtype에서 chunk 경계가 흔들리면 같은 프롬프트와 같은 모델을 써도 검색 결과, 답변 근거, 환각률, 지연시간이 모두 달라집니다.
이 문서는 `/implement`가 청킹 전략을 구현하고 `/test`가 retrieval eval로 완료를 증명할 때 쓰는 결정 규칙입니다.

## 호출 명세

| 호출자 | 호출 시점 | 산출물 변경 |
|---|---|---|
| `commands/implement.md` Step 3 | `llm-app` subtype에서 RAG 통합, 문서 ingest, vector store 적재를 구현할 때 | `10-planning/architecture.md` 또는 `30-docs/rag.md`에 `## RAG 청킹 전략` 추가, `src/`에 chunker 구현, `evals/llm-app/`에 retrieval fixture 초안 추가 |
| `commands/test.md` Step 2 | RAG 설정, chunk size, overlap, embedding model, metadata schema가 바뀐 뒤 | `evals/llm-app/retrieval/`에 query set·answer key를 추가하고, Recall@k/MRR/latency 리포트는 `40-reports/evals/llm-app.md`에 저장 |
| `commands/review.md` RAG 품질 점검 | 근거 누락, 환각, 느린 검색, 코드/표 깨짐을 확인할 때 | 리뷰 리포트에 [§ 검증 체크리스트](#검증-체크리스트) 통과율과 미달 항목 기록 |

---

## 1. 언제 적용

- `/specify llm-app` 또는 `/implement` 결과에 RAG, knowledge base, vector search, semantic search가 포함된 경우
- `20-knowledge/`, `30-docs/`, PDF, HTML, Markdown, 코드 파일을 임베딩하여 검색할 경우
- chunk size, overlap, embedding model, vector store 필터, metadata schema 중 하나라도 변경된 경우
- `/test`에서 LLM 앱 완료 기준에 Recall@k, MRR, p50/p95 latency를 넣어야 하는 경우

## 2. 언제 적용하지 않음

- **전체 문서가 context window에 안정적으로 들어가는 경우** — 1~2개 짧은 문서를 통째로 넣고 비용·지연시간이 허용되면 prompt context 조립을 우선합니다.
- **단일 짧은 문서만 다루는 경우** — 1,500 tokens 이하의 FAQ, 공지, 짧은 정책 문서는 source 단위 metadata만으로 충분할 수 있습니다.
- **정확한 키워드 검색이 주계약인 경우** — 법령 조항 번호, 제품 SKU, 함수명처럼 exact match가 핵심이면 BM25 또는 DB index가 1차입니다.
- **데이터 정제가 아직 안 된 상태** — PDF 헤더/푸터, HTML 네비게이션, 중복 boilerplate를 제거하지 않았다면 ingest 정제를 먼저 끝냅니다.
- **정답 근거를 사람이 지정할 수 없는 초기 탐색** — eval set이 없으면 임시 전략은 가능하지만 완료 처리하지 않습니다.

## 3. 선택 매트릭스

문서 유형과 사용 패턴을 먼저 고정한 뒤, 1순위 전략을 구현하고 2순위는 fallback으로 둡니다.

| 문서 유형 | QA | 요약 | 검색 |
|---|---|---|---|
| 코드 | Document-structure-aware: 파일→클래스/함수 단위, 시그니처와 docstring 보존 | Recursive: 함수 묶음→파일 요약, 테스트 파일 연결 | Fixed-size 보조 + symbol metadata, exact filter 우선 |
| 마크다운 | Document-structure-aware: H1/H2/H3 경로를 `parent_section`에 저장 | H2 단위 chunk 후 상위 heading 요약 | Recursive: 단락→문장 fallback, 표/코드 블록 보존 |
| PDF | Recursive: 페이지 정제 후 단락→문장, page metadata 필수 | Document-structure-aware: 목차/섹션이 추출되면 heading 기준 | Semantic: OCR·레이아웃 잡음이 크면 의미 변화 지점 기준 |
| HTML | Document-structure-aware: 본문 추출 후 heading, link text 보존 | Recursive: article section별 요약 | Semantic: 긴 웹문서에서 주제 전환이 잦을 때 |

선택 절차: 원본 형식과 사용 패턴을 고정하고, 위 표의 1순위 전략·chunk size·overlap·보존 단위를 기록한 뒤 최소 30개 query eval set으로 Recall@5, MRR, p95 latency를 측정합니다. 기준 미달이면 chunk size 조정 → overlap 조정 → 전략 변경 순서로만 바꿉니다.

---

## 4. 4가지 Chunking 전략

### 4.1 Fixed-size (token 기반)

균일한 로그, 짧은 FAQ 묶음, 이미 구조가 약한 텍스트에 사용합니다.
기본값은 400 tokens, overlap 80 tokens이며 허용 범위는 200~500 tokens, overlap 10~20%입니다.
25%를 넘는 overlap은 저장 비용과 중복 검색을 늘리므로 실패로 봅니다.

```python
def fixed_chunk(text, chunk_size=400, overlap=80):
    tokens = tokenize(text)
    chunks = []
    for i in range(0, len(tokens), chunk_size - overlap):
        chunks.append(detokenize(tokens[i:i + chunk_size]))
    return chunks
```

구현 규칙: tokenizer는 하나로 고정하고, overlap은 `overlap_with`에 기록하며, 정답 문장이 경계에 걸리면 overlap 조정 후 Recursive로 전환합니다.

### 4.2 Recursive (구조 기반)

PDF 추출 텍스트, 일반 문서, HTML 본문처럼 구조가 일부 남아 있지만 chunk 크기가 불균등한 자료에 사용합니다.
분리자는 단락 → 줄 → 문장 → 단어 순서로 적용하고, 상위 분리자가 실패할 때만 하위 분리자로 내려갑니다.

```python
MAX_CHUNK = 500

def recursive_chunk(text, separators=["\n\n", "\n", ". ", " "]):
    for sep in separators:
        if len(text) <= MAX_CHUNK:
            return [text]
        parts = text.split(sep)
        if len(parts) == 1:
            continue
        chunks = []
        current = ""
        for part in parts:
            candidate = (current + sep + part).strip() if current else part
            if len(candidate) > MAX_CHUNK:
                if current:
                    chunks.append(current)
                current = part
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks
    return [text[:MAX_CHUNK]]
```

구현 규칙: 실제 구현은 token 기준으로 바꾸고, 문장 중간 절단률 5% 초과 시 separator를 재조정하며, PDF는 page·section·표 변환 metadata를 남깁니다.

### 4.3 Semantic (임베딩 기반)

긴 문서에서 주제 전환이 많고 heading이 불완전할 때 사용합니다.
인접 문장 임베딩의 cosine similarity가 0.85 미만으로 떨어지는 지점을 분할 후보로 잡습니다.
비용이 높으므로 Full 모드 또는 품질 문제가 실제로 관찰된 Standard 모드에서 우선합니다.

```python
def semantic_chunk(sentences, threshold=0.85):
    embeddings = [embed(s) for s in sentences]
    chunks = [[sentences[0]]]
    for i, sent in enumerate(sentences[1:], 1):
        sim = cosine(embeddings[i], embeddings[i-1])
        if sim < threshold:
            chunks.append([sent])
        else:
            chunks[-1].append(sent)
    return [" ".join(chunk) for chunk in chunks]
```

구현 규칙: threshold는 0.85에서 시작하고 eval 결과로만 조정하며, 150~600 tokens를 후처리로 강제하고, embedding model 변경 시 재색인합니다.

### 4.4 Document-structure-aware

Markdown, 기술 문서, 코드, HTML article처럼 구조가 검색 의도를 직접 설명하는 자료에 사용합니다.
H1/H2/H3, 코드 블록, 표, 함수/클래스, page를 보존 단위로 취급합니다.
Development 아키타입의 기본 RAG 전략은 이 방식이며, 구조가 없을 때만 Recursive로 내려갑니다.

```python
import re

def structured_chunk(markdown):
    # H2 별로 분할, 코드 블록 보존
    protected = re.sub(r"```[\s\S]*?```", lambda m: m.group(0).replace("\n", "\u0000"), markdown)
    sections = re.split(r"^## ", protected, flags=re.MULTILINE)
    chunks = [s.replace("\u0000", "\n") for s in sections if len(s) > 50]
    return chunks
```

구현 규칙: 코드 블록 내부는 분할하지 않고, 표 header row와 data row를 같은 chunk에 두며, `parent_section`은 `H1 > H2 > H3` 경로로 저장합니다.

---

## 5. 메타데이터 스키마

모든 chunk는 아래 필드를 가져야 합니다. 하나라도 빠지면 `/test`의 retrieval eval 전 단계에서 실패합니다.

```json
{
  "chunk_id": "src-guide-0007",
  "source_id": "30-docs/rag.md",
  "parent_section": "RAG 구현 > 청킹 전략",
  "chunk_index": 7,
  "token_count": 386,
  "overlap_with": ["src-guide-0006"],
  "embedding_model": "text-embedding-3-small",
  "created_at": "2026-05-07T10:30:00+09:00"
}
```

필드 규칙: `chunk_id`는 deterministic id, `source_id`는 원본 추적자, `parent_section`은 사용자가 이해 가능한 경로, `chunk_index`는 source 내부 순서, `token_count`는 embedding 입력 기준, `overlap_with`는 이전 chunk id 배열, `embedding_model`은 재색인 기준, `created_at`은 ISO 8601 시점입니다. 권장 추가 필드는 `source_type`, `language`, `page`, `content_hash`, `permissions`입니다.

## 6. Retrieval eval harness

RAG chunking은 "검색이 잘 되는 느낌"으로 완료하지 않습니다.
`evals/llm-app/retrieval/`에 최소 30개 query와 정답 chunk id를 둔 뒤, 같은 index에서 자동 측정합니다.

```python
def evaluate_retrieval(queries, retriever, k=5):
    recalls, reciprocal_ranks, latencies = [], [], []
    for query in queries:
        started = monotonic_ms()
        results = retriever.search(query["text"], k=k)
        latencies.append(monotonic_ms() - started)
        expected = set(query["expected_chunk_ids"])
        top_k = {r["chunk_id"] for r in results[:k]}
        recalls.append(int(bool(top_k & expected)))
        reciprocal_ranks.append(next((1 / rank for rank, r in enumerate(results, 1) if r["chunk_id"] in expected), 0))
    return {
        "recall_at_5": sum(recalls) / len(recalls),
        "mrr": sum(reciprocal_ranks) / len(reciprocal_ranks),
        "p50_latency_ms": percentile(latencies, 50),
        "p95_latency_ms": percentile(latencies, 95),
    }
```

지표 기준:
- **Recall@5** — 상위 5개 chunk 안에 정답 chunk가 하나 이상 있으면 1점입니다. 기준은 `0.80` 이상입니다.
- **MRR** — 첫 정답 chunk가 몇 번째에 나오는지 봅니다. 기준은 `0.60` 이상입니다.
- **Latency p50/p95** — 검색만 측정합니다. 기준은 p95 `< 500ms`입니다.
- **회귀 조건** — chunk size, overlap, metadata schema, embedding model, reranker 중 하나라도 바뀌면 eval을 재실행합니다.

---

## 7. 좋은 예 vs 나쁜 예 (3쌍)

### 쌍 1 — 청킹 전략 기록

**나쁜 예**: "LangChain RecursiveCharacterTextSplitter 사용. chunk_size=1000."

**좋은 예**: "Markdown 기술 문서라 Document-structure-aware를 사용합니다. H2 단위로 나누고 400 tokens를 넘는 section은 Recursive fallback을 적용합니다. overlap은 80 tokens이며 코드 블록과 표는 경계에서 분할하지 않습니다."

차이: 나쁜 예는 라이브러리 기본값이고, 좋은 예는 문서 유형·경계 보존·fallback·수치가 모두 검증 가능합니다.

### 쌍 2 — metadata

**나쁜 예**: "`source`, `page` 정도만 넣음."

**좋은 예**: "`chunk_id`, `source_id`, `parent_section`, `chunk_index`, `token_count`, `overlap_with`, `embedding_model`, `created_at`을 모든 chunk에 저장합니다."

차이: 나쁜 예는 근거 추적과 재색인이 어렵고, 좋은 예는 retrieval 결과를 원본 위치와 index 버전으로 되돌릴 수 있습니다.

### 쌍 3 — eval 결과

**나쁜 예**: "검색 결과가 괜찮음. 답변도 자연스러움."

**좋은 예**: "30 query eval set에서 Recall@5 = 0.82, MRR = 0.71, p95 retrieval latency = 312ms입니다. 실패 query 5건은 PDF 표 경계 분할과 재색인 누락으로 분류됐습니다."

차이: 나쁜 예는 감상이고, 좋은 예는 재현 가능한 지표와 수정 방향을 제공합니다.

## 8. 산출물 diff (`/implement`, `/test` 산출물 변화)

**확장 전**:
```markdown
## RAG 구현
LangChain RecursiveCharacterTextSplitter로 chunking. chunk_size=1000.
```

**확장 후**:
```markdown
## RAG 구현 (chunking v2.0)
- 전략: Document-structure-aware (markdown H2 분할)
- chunk_size: 400 tokens (`tiktoken` cl100k_base 기준)
- overlap: 80 tokens (20%)
- 메타데이터: chunk_id, source_id, parent_section (H1/H2 경로), chunk_index, token_count, embedding_model=text-embedding-3-small
- 코드 블록 보존: ```~``` 사이는 분할 금지

## eval 결과
- 30 query eval set: Recall@5 = 0.82, MRR = 0.71
- p95 latency: 312ms
- 검증 체크리스트: 11/12 통과 (1건 미달: #11 eval set이 chunk_id 정답 포함 X)
```

`/implement` 산출물에는 `30-docs/rag.md` 또는 `10-planning/architecture.md`의 전략·수치·metadata schema·보존 단위, `src/`의 chunker, `evals/llm-app/retrieval/queries.jsonl` 초안이 남습니다.
`/test` 산출물에는 `subtype-eval-harness.md`의 LLM 앱 섹션에 붙는 Recall@5, MRR, p50/p95 latency, chunk_size·overlap·embedding_model 변경 시 eval 재실행 여부가 남습니다.

## 9. 검증 체크리스트

- [ ] 1. 모든 chunk에 `chunk_id`, `source_id`, `token_count` 메타데이터가 있는가
- [ ] 2. overlap이 chunk_size의 10~25% 범위인가
- [ ] 3. `embedding_model`이 chunk 메타데이터에 명시됐는가
- [ ] 4. Recall@5 ≥ 0.8 인가 (eval set 기준)
- [ ] 5. MRR ≥ 0.6 인가
- [ ] 6. p95 retrieval latency < 500ms 인가
- [ ] 7. 코드 블록이 chunk 경계에서 깨지지 않는가
- [ ] 8. 표 구조가 chunk 경계에서 보존되는가
- [ ] 9. 동일 source의 chunk들이 `chunk_index`로 순서 추적되는가
- [ ] 10. eval set이 최소 30개 query를 포함하는가
- [ ] 11. eval set이 retrieval 시 `chunk_id` 정답을 포함하는가
- [ ] 12. chunk_size 변경 시 eval이 자동 재실행되는가
- [ ] 13. `parent_section`이 사용자가 이해 가능한 heading, page, symbol 경로인가
- [ ] 14. embedding model 변경 시 재색인 또는 stale index 감지가 동작하는가
- [ ] 15. 실패 query가 category별로 기록되어 전략 조정 근거가 남는가

판정 기준: 1~3 실패는 `/implement` metadata 수정, 4~6 실패는 `/test` retrieval eval 후 전략 재조정, 7~12 실패는 완료 불가, 13~15는 Full 모드 필수입니다.

## 다른 framework와의 관계

- **`subtype-eval-harness.md`** — LLM 앱의 전체 완료 증명은 prompt snapshot, schema, token budget, latency를 포함합니다. 이 문서는 그중 RAG retrieval 하위 지표인 Recall@k, MRR, latency, 근거 chunk 추적을 담당합니다.
- **`owasp-top10.md`** — RAG가 외부 문서, 사용자별 권한, 내부 지식베이스를 검색하면 A01 접근제어 실패와 A06 취약·오래된 구성요소 문제가 연결됩니다. chunk metadata에 `permissions`, `source_id`, `created_at`, `embedding_model`을 남겨 stale index와 권한 누락을 리뷰할 수 있게 합니다.
- **`solid-principles.md`** — chunker, embedder, retriever, evaluator를 분리하면 전략 교체와 eval 회귀가 쉬워집니다. 단일 함수에 ingest부터 검색까지 몰아넣으면 LLM 앱 subtype의 완료 증명이 불가능합니다.
## 변경 이력

| 날짜 | 변경 | 사유 |
|---|---|---|
| 2026-05-06 | 최초 도입 (47줄, 기본 전략과 파라미터 요약) | Development 아키타입 LLM 앱 RAG 기준 추가 |
| 2026-05-07 | Golden Sample v2.0 — 7섹션 계약 적용, 선택 매트릭스, 4가지 청킹 전략 코드, 필수 metadata schema, retrieval eval harness, 좋은 예/나쁜 예, `/implement`·`/test` 산출물 diff, 15항목 체크리스트 추가 | Codex Round 3 권고 반영: chunk size, overlap, metadata, retrieval eval이 얇으면 구현 결과가 일반론으로 흐르는 문제 해결 |
