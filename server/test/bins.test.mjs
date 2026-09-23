// v2 수신(/v2/bins): 창 계산(공용 계산기)·upsert(같은 내용 1행·메시지 감소 거부)·엄격 스키마·본문 한도·계정 결속·v1 426·레이트 제한·다PC 합산·중복 수집 의심.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, linkDevice } from './harness.mjs';

let srv, alice, bob, aTok, bTok, a2Tok;
before(async () => {
  srv = await startServer();
  alice = await login(srv.base, 'v2alice'); bob = await login(srv.base, 'v2bob');
  aTok = (await linkDevice(srv.base, alice)).token.device_token;
  a2Tok = (await linkDevice(srv.base, alice)).token.device_token; // 같은 사용자의 두 번째 PC
  bTok = (await linkDevice(srv.base, bob)).token.device_token;
});
after(async () => { await srv?.stop(); });

const BIN = 300000;
const T0 = Math.floor((Date.now() - 6 * 3600000) / BIN) * BIN;
const RESET7 = new Date(T0 + 5 * 86400000).toISOString();
const post = async (tok, body, raw) => {
  const r = await fetch(`${srv.base}/v2/bins`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: raw ?? JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bin = (i, o = {}) => ({ bin_start: T0 + i * BIN, model: 'claude-opus-5-5', input: 1_000_000, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
  cache_write_unknown: 0, messages: 2, sidechain_messages: 0, special: {}, revision: (i.toString(16) + 'a'.repeat(16)).slice(0, 16), ...o });
const smp = (min, u) => ({ observed_at: T0 + min * 60000, gauge: '7d', utilization: u, resets_at: RESET7, source: 'usage_api', tier: 'default_claude_max_5x' });
const payload = (fp, o = {}) => ({ account_fp: fp, tier: 'default_claude_max_5x', bins: [], samples: [], client: { version: '0.2.0', collector: 'transcript' }, ...o });
const me = async cookie => (await fetch(`${srv.base}/me.json`, { headers: { cookie } })).json();

test('bin·샘플 수신 → 창 계산: 비용·범위·단계, 같은 내용 재전송은 1행, 메시지 수 감소 갱신은 무시', async () => {
  const fp = '1'.repeat(64);
  const bins = []; for (let i = 1; i < 24; i++) bins.push(bin(i)); // 5분마다 $4 (opus-5-5 input $4/M)
  const r = await post(aTok, payload(fp, { bins, samples: [smp(0, 10), smp(60, 16), smp(120, 22), smp(130, 22)] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.windows >= 1);
  const w = (await me(alice)).windows.find(x => x.public_tag === '1111' && x.gauge === '7d');
  assert.equal(w.delta, 12); assert.equal(w.stage, 'precise'); assert.equal(w.exclude_reason, null);
  assert.ok(Math.abs(w.usd_per_pct - w.cost / 12) < 1e-6);
  assert.ok(w.usd_per_pct_lo <= w.usd_per_pct && w.usd_per_pct <= w.usd_per_pct_hi);
  assert.match(w.price_version, /^[vp]-[0-9a-f]{16}$/);
  assert.equal(w.calc_version, 'window-v1');
  const cost1 = w.cost;
  await post(aTok, payload(fp, { bins }));
  await post(aTok, payload(fp, { bins: [bin(1, { messages: 1, input: 1, revision: 'b'.repeat(16) })] })); // 메시지 감소 → 무시
  const w2 = (await me(alice)).windows.find(x => x.public_tag === '1111' && x.gauge === '7d');
  assert.equal(w2.cost, cost1, '재전송·오래된 revision은 값 불변');
  await post(aTok, payload(fp, { bins: [bin(2, { messages: 3, input: 2_000_000, revision: 'c'.repeat(16) })] })); // 갱신
  const w3 = (await me(alice)).windows.find(x => x.public_tag === '1111' && x.gauge === '7d');
  assert.ok(Math.abs(w3.cost - (cost1 + 4)) < 1e-6, '같은 bin 갱신은 교체(+$4)');
});

test('엄격 스키마·본문 한도·다른 사용자 계정 409·v1 426', async () => {
  const fp = '2'.repeat(64);
  assert.equal((await post(aTok, { ...payload(fp, { samples: [smp(0, 1)] }), email: 'x@y.z' })).status, 422);
  assert.equal((await post(aTok, payload(fp, { bins: [{ ...bin(1), path: '/Users/x' }] }))).body.reason, 'unknown_bin_field');
  assert.equal((await post(aTok, payload(fp, { bins: [bin(1, { bin_start: T0 + 1 })] }))).body.reason, 'invalid_bin_start');
  assert.equal((await post(aTok, payload(fp, { samples: [{ ...smp(0, 101) }] }))).body.reason, 'invalid_sample');
  assert.equal((await post(aTok, null, 'x'.repeat(300 * 1024))).status, 413);
  assert.equal((await post(aTok, payload(fp, { samples: [smp(0, 1)] }))).status, 201);
  assert.equal((await post(bTok, payload(fp, { samples: [smp(5, 2)] }))).status, 409);
  const v1 = await fetch(`${srv.base}/v1/intervals`, { method: 'POST', headers: { authorization: `Bearer ${aTok}` }, body: '{}' });
  assert.equal(v1.status, 426);
});

test('다PC: 같은 계정 두 기기 bin 합산, 똑같은 bin을 두 기기가 내면 중복 수집 의심으로 창 제외', async () => {
  const fp = '3'.repeat(64), samples = [smp(0, 0), smp(60, 12), smp(70, 12)];
  await post(aTok, payload(fp, { bins: [bin(2), bin(4)], samples }));
  await post(a2Tok, payload(fp, { bins: [bin(3)] }));
  const w = (await me(alice)).windows.find(x => x.public_tag === '3333' && x.gauge === '7d');
  assert.equal(w.devices, 2); assert.ok(Math.abs(w.cost - 12) < 1e-6, '세 bin × $4');
  assert.equal(w.exclude_reason, null);
  await post(a2Tok, payload(fp, { bins: [bin(2)] })); // 기기1과 같은 내용
  const w2 = (await me(alice)).windows.find(x => x.public_tag === '3333' && x.gauge === '7d');
  assert.equal(w2.exclude_reason, 'duplicate_collection_suspected');
});

test('요청 기준 레이트 제한(기기당 분당 20)', async () => {
  const bob2 = await login(srv.base, 'v2rate');
  const tok = (await linkDevice(srv.base, bob2)).token.device_token;
  const fp = '4'.repeat(64);
  let last;
  for (let i = 0; i < 22; i++) last = await post(tok, payload(fp, { samples: [smp(i, i)] }));
  assert.equal(last.status, 429);
});
