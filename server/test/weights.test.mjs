// M5 보조 지표 순수 로직: 성분별 가중치 회귀가 합성 가중치를 되찾는지, 표본 미달이면 측정 대기, 지연 추정.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWeights, composition, bestLag, lagSummary } from '../src/weights.js';

// 결정적 의사난수
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('가중치 회귀: 합성 w(입력 1, 출력 1, 캐시 읽기 3, 캐시 쓰기 0.5)를 상대값으로 되찾는다', () => {
  const w = { input: 1, output: 1, cache_read: 3, cache_write: 0.5 };
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const parts = { input: rnd() * 5, output: rnd() * 10, cache_read: rnd() * 8, cache_write: rnd() * 6 };
    rows.push({ account: `a${i % 6}`, delta: Object.keys(w).reduce((s, k) => s + w[k] * parts[k], 0), parts });
  }
  const r = fitWeights(rows);
  assert.equal(r.status, 'ok');
  const avg = rows.reduce((s, x) => s + x.delta, 0) / rows.reduce((s, x) => s + Object.values(x.parts).reduce((a, b) => a + b, 0), 0);
  for (const k of Object.keys(w)) assert.ok(Math.abs(r.relative[k] - w[k] / avg) < 1e-6, k);
  assert.ok(r.relative.cache_read > r.relative.input * 2.9);
  assert.ok(r.r2 > 0.999);
  const c = composition(rows);
  assert.ok(Math.abs(Object.values(c).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('표본 미달(창 30개·계정 5개)이면 측정 대기, 값은 null', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ account: `a${i % 4}`, delta: 5, parts: { input: 1, output: 1, cache_read: 1, cache_write: 1 } }));
  const r = fitWeights(rows);
  assert.equal(r.status, 'waiting'); assert.equal(r.relative, null); assert.equal(r.accounts, 4);
  assert.equal(composition(rows), null);
  const few = fitWeights(rows.slice(0, 10).map((x, i) => ({ ...x, account: `b${i}` })));
  assert.equal(few.status, 'waiting');
});

test('모든 창 구성이 같아 분리할 수 없으면 unidentifiable', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ account: `a${i % 8}`, delta: 5, parts: { input: 1, output: 2, cache_read: 3, cache_write: 4 } }));
  assert.equal(fitWeights(rows).status, 'unidentifiable');
});

test('지연 추정: 10분 늦게 반영되는 게이지에서 10분을 고른다, 표본 부족이면 null·측정 대기', () => {
  const T = 0, M = 60000;
  const bins = [[T + 5 * M, 2], [T + 20 * M, 4], [T + 45 * M, 1], [T + 70 * M, 3]];
  const cum = t => bins.reduce((s, [bt, c]) => (bt <= t ? s + c : s), 0);
  const samples = [];
  for (let t = 0; t <= 100 * M; t += 5 * M) samples.push([t, 10 + 2 * cum(t - 10 * M)]);
  assert.equal(bestLag(samples, bins), 10);
  assert.equal(bestLag(samples.slice(0, 3), bins), null);
  assert.equal(lagSummary([10, 10, 5]).status, 'waiting');
  assert.equal(lagSummary(Array(12).fill(10)).median_min, 10);
});
