// 헤더 틱 구간 계산 fixture 회귀.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger, parseLifecycle, computeIntervals, localCost } from '../src/interval.mjs';
import { COLUMNS } from '../src/recorder.mjs';

const T0 = 1790152000000;
const RESET5 = 1790160000, RESET7 = 1790600000;
let n = 0;
function row(o) {
  n++;
  const base = { ts_ms: T0 + n * 1000, started_ms: T0 + n * 1000 - 500, ended_ms: T0 + n * 1000 + 500, model: 'claude-opus-5-5',
    input: 1000, output: 100, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cache_write_unknown: 0,
    u5h: 0.1, u7d: 0.02, reset_5h: RESET5, reset_7d: RESET7, http_status: 200, stream: 1, schema_version: 3,
    local_request_id: `r${n}`, complete: 1, usage_observed: 1, quality: 'complete', account_fp: 'fpA', tier: 'default_claude_max_5x' };
  return { ...base, ...o };
}
const ledgerText = rows => COLUMNS.join('\t') + '\n' + rows.map(r => COLUMNS.map(c => r[c] ?? '').join('\t')).join('\n') + '\n';
const lifeText = rows => rows.flatMap(r => ['start', 'end'].map(type => JSON.stringify({ type, local_request_id: r.local_request_id, at_ms: r.started_ms }))).join('\n') + '\n';
const compute = (rows, opts = {}, life = lifeText(rows)) => computeIntervals({ ...parseLedger(ledgerText(rows)), lifecycle: parseLifecycle(life) }, { now: T0 + 1e9, ...opts });
const seq = (vals, extra = {}) => { n = 0; return vals.map(v => row({ u5h: v, ...extra })); };

test('5h: 3틱 이상에서 구간 생성, 토큰은 완료 기준 (A,B]', () => {
  const rows = seq([0.10, 0.11, 0.11, 0.12, 0.13, 0.14, 0.14]);
  const { intervals } = compute(rows);
  const five = intervals.filter(i => i.gauge === '5h');
  assert.equal(five.length, 1);
  const i = five[0];
  assert.equal(i.g_start, 11); assert.equal(i.g_end, 14);
  // 11% 틱 = rows[1].ts, 14% 틱 = rows[5].ts. (A,B]에 끝난 요청: rows[1..4] (ended = ts+500)
  assert.equal(i.requests, 4);
  assert.equal(i.tokens_by_model['claude-opus-5-5'].input, 4000);
  assert.equal(i.tier, 'default_claude_max_5x');
  assert.deepEqual(i.quality, []);
  assert.equal(i.routed_upstream, false);
});

test('게이지 흔들림(역행)은 틱으로 세지 않는다', () => {
  const { intervals } = compute(seq([0.10, 0.11, 0.10, 0.11, 0.12, 0.11, 0.12, 0.13]));
  const five = intervals.filter(i => i.gauge === '5h');
  assert.equal(five.length, 0, '11→13은 2틱 — 3틱 미만');
  const { intervals: i2 } = compute(seq([0.10, 0.11, 0.10, 0.12, 0.11, 0.13, 0.14]));
  assert.equal(i2.filter(i => i.gauge === '5h').length, 1);
});

test('reset이 바뀌면 창을 나눠 구간이 창을 넘지 않는다', () => {
  n = 0;
  const rows = [0.10, 0.11, 0.12].map(v => row({ u5h: v })).concat([0.01, 0.02, 0.03].map(v => row({ u5h: v, reset_5h: RESET5 + 18000 })));
  assert.equal(compute(rows).intervals.filter(i => i.gauge === '5h').length, 0);
});

test('reset 2초 이내 흔들림은 같은 창', () => {
  n = 0;
  const rows = [0.10, 0.11, 0.12, 0.13, 0.14].map((v, k) => row({ u5h: v, reset_5h: k % 2 ? RESET5 + 0.7 : new Date(RESET5 * 1000).toISOString() }));
  assert.equal(compute(rows).intervals.filter(i => i.gauge === '5h').length, 1);
});

test('주간은 1틱부터, 5시간과 섞지 않는다', () => {
  n = 0;
  const rows = [[0.10, 0.02], [0.11, 0.02], [0.12, 0.03], [0.13, 0.04]].map(([a, b]) => row({ u5h: a, u7d: b }));
  const week = compute(rows).intervals.filter(i => i.gauge === '7d');
  assert.equal(week.length, 1);
  assert.equal(week[0].g_start, 3); assert.equal(week[0].g_end, 4);
});

test('경계 직전 시작해 아직 안 끝난 요청이 있으면 보류, 오래되면 품질 플래그', () => {
  const rows = seq([0.10, 0.11, 0.12, 0.13, 0.14]);
  const life = lifeText(rows) + JSON.stringify({ type: 'start', local_request_id: 'crash', at_ms: rows[2].ts_ms }) + '\n';
  const recent = compute(rows, { now: rows[4].ts_ms + 1000 }, life);
  assert.equal(recent.intervals.filter(i => i.gauge === '5h').length, 0);
  assert.equal(recent.waiting, 1);
  const old = compute(rows, { now: rows[4].ts_ms + 11 * 60000 }, life);
  const i = old.intervals.find(i => i.gauge === '5h');
  assert.ok(i.quality.includes('pending_or_interrupted_requests'));
});

test('계정을 모르는 요청은 구간에 넣지 않는다', () => {
  const rows = seq([0.10, 0.11, 0.12, 0.13, 0.14], { account_fp: '' });
  assert.equal(compute(rows).intervals.length, 0);
});

test('경계에 걸친 요청 토큰을 따로 보낸다', () => {
  const rows = seq([0.10, 0.11, 0.12, 0.13, 0.14]);
  rows.push({ ...row({ u5h: 0.13 }), started_ms: rows[1].ts_ms - 10, ended_ms: rows[4].ts_ms + 10, ts_ms: rows[1].ts_ms - 5, input: 777 });
  const i = compute(rows).intervals.find(i => i.gauge === '5h');
  // 경계 틱을 만든 요청 자신(1000)도 헤더 수신 시점엔 진행 중이므로 불확실 구간에 포함된다.
  assert.equal(i.boundary.start_inflight_by_model['claude-opus-5-5'].input, 1777);
  assert.equal(i.boundary.end_inflight_by_model['claude-opus-5-5'].input, 1777);
});

test('interval_id는 같은 입력에서 결정적이고 UUID 형식', () => {
  const a = compute(seq([0.10, 0.11, 0.12, 0.13, 0.14])).intervals[0].interval_id;
  const b = compute(seq([0.10, 0.11, 0.12, 0.13, 0.14])).intervals[0].interval_id;
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('라우터 경유·불완전 요청은 플래그로 드러난다', () => {
  const rows = seq([0.10, 0.11, 0.12, 0.13, 0.14]);
  rows[2].quality = 'routed_upstream'; rows[3].complete = 0; rows[3].quality = 'incomplete_stream';
  const i = compute(rows).intervals.find(i => i.gauge === '5h');
  assert.equal(i.routed_upstream, true);
  assert.ok(i.quality.includes('incomplete_usage'));
  assert.ok(i.quality.includes('incomplete_stream'));
});

test('끝 열이 빈 행을 형식 오류로 보지 않는다 (trimEnd 회귀)', () => {
  const rows = seq([0.1], { account_fp: '', tier: '' });
  const { rows: parsed } = parseLedger(ledgerText(rows));
  assert.ok(!parsed[0].quality.has('malformed_row'));
});

test('lifecycle이 없으면 플래그', () => {
  const rows = seq([0.10, 0.11, 0.12, 0.13, 0.14]);
  const { intervals } = computeIntervals({ ...parseLedger(ledgerText(rows)), lifecycle: null }, { now: T0 + 1e9 });
  assert.ok(intervals[0].quality.includes('lifecycle_unavailable'));
});

test('로컬 비용: 미등록 모델·TTL 미확인이면 null (0으로 두지 않음)', () => {
  assert.equal(localCost({ 'claude-opus-5-5': { input: 1e6, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cache_write_unknown: 0 } }), 4);
  assert.equal(localCost({ 'unknown-model': { input: 1, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cache_write_unknown: 0 } }), null);
  assert.equal(localCost({ 'claude-opus-5-5': { input: 1, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cache_write_unknown: 5 } }), null);
});

test('기록 공백: 이웃 관측 사이 급점프(5h >5%p)면 그 사이를 구간으로 잇지 않는다', () => {
  // 10,11 → (기록 밖 사용) → 40,41,42,43 : 11→40 은 끊고 40→43만 구간
  const { intervals } = compute(seq([0.10, 0.11, 0.40, 0.41, 0.42, 0.43]));
  const five = intervals.filter(i => i.gauge === '5h');
  assert.deepEqual(five.map(i => `${i.g_start}→${i.g_end}`), ['40→43']);
});

test('기록 공백: 앞 관측과 3분 넘게 떨어졌는데 게이지가 오르면 끊는다(주간 1%p라도)', () => {
  n = 0;
  const rows = [row({ u7d: 0.15 }), row({ u7d: 0.15 })];
  const later = T0 + 10 * 60000; // 10분 뒤 첫 관측에서 16%
  rows.push(row({ u7d: 0.16, ts_ms: later, started_ms: later - 500, ended_ms: later + 500 }));
  for (let k = 1; k <= 3; k++) rows.push(row({ u7d: 0.16 + k / 100, ts_ms: later + k * 1000, started_ms: later + k * 1000 - 500, ended_ms: later + k * 1000 + 500 }));
  const seven = compute(rows).intervals.filter(i => i.gauge === '7d');
  assert.deepEqual(seven.map(i => `${i.g_start}→${i.g_end}`), ['16→17', '17→18', '18→19'], '15→16(공백 건너기)은 없음');
});
