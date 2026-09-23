// 단가 자동 공급: LiteLLM 형식 픽스처로 cron 실행 → 변경분만 새 행, 급변은 보류, 같은 값은 출처 확인으로 verified.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './harness.mjs';

const entry = (inp, out, w5, w1, rd) => ({ litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: inp / 1e6, output_cost_per_token: out / 1e6,
  cache_creation_input_token_cost: w5 / 1e6, cache_creation_input_token_cost_above_1hr: w1 / 1e6, cache_read_input_token_cost: rd / 1e6,
  provider_specific_entry: { fast: 2.0 }, search_context_cost_per_query: { search_context_size_low: 0.01 } });
const fixture = {
  sample_spec: { max_tokens: 1 },
  'claude-opus-5-5': entry(4, 20, 5, 8, 0.2),               // 동일 → verified 표시만
  'claude-opus-5': entry(5, 25, 6.25, 10, 0.55),            // cache_read 0.5→0.55 (+10%) → 새 행
  'claude-opus-4-8': entry(15, 25, 6.25, 10, 0.5),          // input 5→15 (3배) → 보류
  'claude-fable-5-1': entry(10, 50, 12.5, 20, 0.25), 'claude-fable-5': entry(10, 50, 12.5, 20, 0.25),
  'claude-sonnet-5': entry(2, 10, 2.5, 4, 0.2), 'claude-haiku-4-5': entry(1, 5, 1.25, 2, 0.1),
  'claude-haiku-4-5-20251001': entry(1, 5, 1.25, 2, 0.1), 'claude-sonnet-4-6': entry(3, 15, 3.75, 6, 0.3),
  'anthropic.claude-opus-5-5': { ...entry(99, 99, 99, 99, 99), litellm_provider: 'bedrock' },
  'gpt-x': { litellm_provider: 'openai', input_cost_per_token: 1 },
};
let src, srv;
before(async () => {
  src = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(fixture, null, 4)); });
  await new Promise(r => src.listen(0, '127.0.0.1', r));
  srv = await startServer({ PRICE_SOURCE_URL: `http://127.0.0.1:${src.address().port}/prices.json` });
});
after(async () => { await srv?.stop(); src?.close(); });

test('cron 단가 동기화: 변경분만 반영, 급변 보류, 동일값은 출처 확인', async () => {
  const before = await (await fetch(`${srv.base}/api/stats`)).json();
  assert.equal(before.price_status, 'provisional');
  const r = await fetch(`${srv.base}/__scheduled?cron=17+3+*+*+*`);
  assert.equal(r.status, 200);
  await new Promise(res => setTimeout(res, 500));
  const log = srv.log();
  const line = /price_sync (\{.*\})/.exec(log)?.[1];
  assert.ok(line, 'price_sync 로그 없음:\n' + log.slice(-800));
  const res = JSON.parse(line);
  assert.equal(res.ok, true);
  assert.equal(res.models, 9, 'bedrock·openai 항목 제외');
  assert.equal(res.held, 1, 'opus-4-8 input 3배는 보류');
});

test('같은 날 두 번 바뀐 단가도 이력을 덮어쓰지 않는다(valid_from=시각, INSERT만)', async () => {
  const { syncPrices } = await import('../src/pricing.js');
  const rows = [{ model: 'claude-opus-5', component: 'input', usd_per_mtok: 5, valid_from: '2026-01-01' }];
  const DB = {
    prepare: sql => ({
      bind: (...a) => ({ sql, a }),
      all: async () => ({ results: [...rows].sort((x, y) => (x.valid_from < y.valid_from ? 1 : -1)) }),
    }),
    batch: async stmts => {
      for (const { sql, a } of stmts) {
        if (!sql.startsWith('INSERT')) continue;
        assert.ok(!/OR REPLACE/.test(sql), '덮어쓰기 금지');
        const [model, component, usd_per_mtok, valid_from] = a;
        if (rows.some(r => r.model === model && r.component === component && r.valid_from === valid_from)) throw Error('UNIQUE constraint');
        rows.push({ model, component, usd_per_mtok, valid_from });
      }
    },
  };
  const text = v => JSON.stringify(Object.fromEntries(['claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-fable-5']
    .map(m => [m, entry(m === 'claude-opus-5' ? v : 5, 25, 6.25, 10, 0.5)])), null, 4);
  const fetchOf = v => async () => ({ ok: true, text: async () => text(v) });
  await syncPrices({ DB }, { fetchImpl: fetchOf(5.5), now: new Date('2026-09-24T01:00:00Z') });
  await syncPrices({ DB }, { fetchImpl: fetchOf(6), now: new Date('2026-09-24T13:00:00Z') });
  const hist = rows.filter(r => r.model === 'claude-opus-5' && r.component === 'input').map(r => r.usd_per_mtok).sort();
  assert.deepEqual(hist, [5, 5.5, 6]);
});
