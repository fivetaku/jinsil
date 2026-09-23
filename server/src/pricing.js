// 단가 자동 공급: LiteLLM의 model_prices_and_context_window.json(MIT)에서 Anthropic 직결 모델 단가만 가져온다.
// - 2.75MB 전체를 JSON.parse하지 않고 `"claude-…": {…}` 항목만 잘라 파싱한다(Workers CPU 한도 대비).
// - 검증: 항목 수 하한, 필수 키, 기존 모델 소실 금지, 급변(±50% 초과)은 자동 반영하지 않고 보류.
// - 반영은 값이 바뀐 성분만 새 valid_from 행으로 추가(과거 구간 재계산 근거 보존). 출처·본문 해시를 남긴다.
// 1시간 캐시 쓰기 키 이름은 `cache_creation_input_token_cost_above_1hr`(1시간 TTL 단가, '1시간 초과' 아님).
export const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const COMPONENTS = {
  input: 'input_cost_per_token', output: 'output_cost_per_token', cache_read: 'cache_read_input_token_cost',
  cache_write_5m: 'cache_creation_input_token_cost', cache_write_1h: 'cache_creation_input_token_cost_above_1hr',
};
const MIN_MODELS = 8;
const MAX_JUMP = 0.5;

// 텍스트에서 최상위 "claude-*" 항목만 추출. 항목 안의 중첩 객체(한 단계)는 중괄호 깊이로 처리.
export function extractAnthropic(text) {
  const out = {};
  const re = /\n\s{4}"(claude-[a-z0-9.\-]+)":\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth > 0) { const ch = text[i++]; if (ch === '{') depth++; else if (ch === '}') depth--; }
    try {
      const e = JSON.parse(text.slice(re.lastIndex - 1, i));
      if (e.litellm_provider !== 'anthropic') continue;
      const row = {};
      for (const [c, k] of Object.entries(COMPONENTS)) if (typeof e[k] === 'number') row[c] = Math.round(e[k] * 1e6 * 1e6) / 1e6;
      if (row.input !== undefined && row.output !== undefined) out[m[1]] = row;
    } catch { /* 깨진 항목은 건너뜀 */ }
    re.lastIndex = i;
  }
  return out;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function syncPrices(env, { fetchImpl = fetch, now = new Date() } = {}) {
  const url = env.PRICE_SOURCE_URL || DEFAULT_SOURCE;
  const r = await fetchImpl(url, { cf: { cacheTtl: 3600 } });
  if (!r.ok) return { ok: false, reason: `fetch_${r.status}` };
  const text = await r.text();
  const fresh = extractAnthropic(text);
  if (Object.keys(fresh).length < MIN_MODELS) return { ok: false, reason: 'too_few_models', n: Object.keys(fresh).length };
  const { results } = await env.DB.prepare('SELECT model, component, usd_per_mtok, valid_from FROM prices ORDER BY valid_from DESC').all();
  const current = {};
  for (const x of results) { current[x.model] ||= {}; if (current[x.model][x.component] === undefined) current[x.model][x.component] = x.usd_per_mtok; }
  const missing = Object.keys(current).filter(mo => !fresh[mo]);
  const day = now.toISOString().slice(0, 10);
  // 변경 행의 valid_from은 시각(ISO)으로 — 같은 날 두 번 바뀌어도 앞 이력을 덮어쓰지 않는다.
  const at = now.toISOString();
  const hash = (await sha256Hex(text)).slice(0, 16);
  const source = `${url}#sha256:${hash}`;
  const inserts = [], held = [];
  for (const [model, comps] of Object.entries(fresh)) {
    for (const [c, v] of Object.entries(comps)) {
      const old = current[model]?.[c];
      if (old === v) continue;
      if (old !== undefined && old > 0 && Math.abs(v - old) / old > MAX_JUMP) { held.push({ model, component: c, old, new: v }); continue; }
      inserts.push(env.DB.prepare('INSERT INTO prices (model, component, usd_per_mtok, valid_from, source_url, verified_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(model, c, v, at, source, day));
    }
  }
  // 값이 같아도 출처 확인 기록: 기존 행의 verified_at 이 비어 있으면 이번 대조로 채운다.
  for (const [model, comps] of Object.entries(current)) for (const [c, v] of Object.entries(comps))
    if (fresh[model]?.[c] === v) inserts.push(env.DB.prepare('UPDATE prices SET verified_at = ?, source_url = COALESCE(source_url, ?) WHERE model = ? AND component = ? AND verified_at IS NULL').bind(day, source, model, c));
  for (let i = 0; i < inserts.length; i += 50) await env.DB.batch(inserts.slice(i, i + 50));
  return { ok: true, models: Object.keys(fresh).length, changed: inserts.length, held, missing, source };
}
