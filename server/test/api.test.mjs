// 서버 API 규칙 테스트 (wrangler dev --local). PRD 02 자동 검증 규칙·기기 연결·가성비·순위·스티커.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, linkDevice, interval, post, zero, csrfOf } from './harness.mjs';
import { stickers } from '../src/stats.js';

let srv, alice, bob, aliceToken, bobToken;
before(async () => {
  srv = await startServer();
  alice = await login(srv.base, 'alice');
  bob = await login(srv.base, 'bob');
  const a = await linkDevice(srv.base, alice); aliceToken = a.token.device_token;
  const b = await linkDevice(srv.base, bob); bobToken = b.token.device_token;
});
after(async () => { await srv?.stop(); });
const fp = c => c.repeat(64);

test('기기 코드: 승인 전 428, 승인 후 1회만 토큰(재사용 410), 거부는 403', async () => {
  const ok = await linkDevice(srv.base, alice);
  assert.equal(ok.pendingStatus, 428);
  assert.equal(ok.tokenStatus, 200);
  assert.ok(ok.token.device_token.length > 30);
  assert.equal(ok.againStatus, 410);
  const denied = await linkDevice(srv.base, alice, { approve: false });
  assert.equal(denied.tokenStatus, 403);
});

test('로그인 없이 /me·/link는 로그인으로 보낸다, 모의 IdP 세션은 동작', async () => {
  const r = await fetch(`${srv.base}/me`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/google\?next=/);
  const me = await fetch(`${srv.base}/me.json`, { headers: { cookie: alice } });
  assert.equal(me.status, 200);
});

test('수용: 서버가 단가로 비용을 다시 계산하고, 같은 interval_id 재전송은 멱등', async () => {
  const body = interval({ account_fp: fp('1') });
  const r = await post(srv.base, aliceToken, body);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'accepted');
  assert.equal(r.body.cost_usd, 1_000_000 * 4 / 1e6 + 100_000 * 20 / 1e6); // $6
  const again = await post(srv.base, aliceToken, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
});

test('스키마: 모르는 필드(email 등)·잘못된 지문·음수 토큰·역행 게이지는 422', async () => {
  for (const bad of [interval({ email: 'x@y.z' }), interval({ account_fp: 'nothex' }),
    interval({ tokens_by_model: { 'claude-opus-5-5': { ...zero, input: -1 } } }), interval({ g_start: 5, g_end: 4 }),
    interval({ quality: ['DROP TABLE'] }), interval({ interval_id: 'x' })]) {
    const r = await post(srv.base, aliceToken, bad);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.status, 'rejected');
  }
});

test('겹치는 게이지 구간은 409, 다른 사용자가 같은 계정 지문을 올리면 409', async () => {
  await post(srv.base, aliceToken, interval({ account_fp: fp('2'), g_start: 10, g_end: 12 }));
  const overlap = await post(srv.base, aliceToken, interval({ account_fp: fp('2'), g_start: 11, g_end: 13 }));
  assert.equal(overlap.status, 409); assert.equal(overlap.body.reason, 'overlapping_interval');
  const adjacent = await post(srv.base, aliceToken, interval({ account_fp: fp('2'), g_start: 12, g_end: 13 }));
  assert.equal(adjacent.status, 201);
  const stolen = await post(srv.base, bobToken, interval({ account_fp: fp('2'), g_start: 20, g_end: 21 }));
  assert.equal(stolen.status, 409); assert.equal(stolen.body.reason, 'account_bound_to_other_user');
});

test('통계 제외: 품질 플래그·라우터 경유·단가 미확인·TTL 미확인·틱 부족·요금제 미확인', async () => {
  const cases = [
    [{ quality: ['incomplete_usage'] }, 'incomplete_usage'],
    [{ routed_upstream: true }, 'routed_upstream'],
    [{ tokens_by_model: { 'mystery-model': { ...zero, input: 5 } } }, 'unpriced_model'],
    [{ tokens_by_model: { 'claude-opus-5-5': { ...zero, input: 5, cache_write_unknown: 3 } } }, 'cache_ttl_unknown'],
    [{ gauge: '5h', g_start: 1, g_end: 3 }, 'too_few_ticks'],
    [{ tier: null }, 'tier_unknown'],
  ];
  let g = 40;
  for (const [o, reason] of cases) {
    const r = await post(srv.base, aliceToken, interval({ account_fp: fp('3'), g_start: g, g_end: g + 1, ...o }));
    g += 2;
    assert.equal(r.status, 201); assert.equal(r.body.status, 'excluded'); assert.equal(r.body.reason, reason);
  }
});

test('폐기한 기기의 제출은 401', async () => {
  const d = await linkDevice(srv.base, bob);
  const tok = d.token.device_token;
  assert.equal((await fetch(`${srv.base}/device/revoke`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } })).status, 200);
  const r = await post(srv.base, tok, interval({ account_fp: fp('4') }));
  assert.equal(r.status, 401);
});

test('같은 PC를 다시 연결하면 예전 연결은 해제되어 한 대로 잡힌다', async () => {
  const carol = await login(srv.base, 'carol-relink');
  const first = (await linkDevice(srv.base, carol, { name: 'carol-mac' })).token.device_token;
  const before = (await (await fetch(`${srv.base}/api/stats`)).json()).measuring;
  const second = (await linkDevice(srv.base, carol, { name: 'carol-mac' })).token.device_token;
  const after = (await (await fetch(`${srv.base}/api/stats`)).json()).measuring;
  assert.equal(after.devices, before.devices, 'PC 수가 늘지 않아야 함');
  assert.equal((await post(srv.base, first, interval({ account_fp: fp('c1') }))).status, 401);
  assert.notEqual((await post(srv.base, second, interval({ account_fp: fp('c1') }))).status, 401);
  await linkDevice(srv.base, carol, { name: 'carol-laptop' });
  assert.equal((await (await fetch(`${srv.base}/api/stats`)).json()).measuring.devices, after.devices + 1, '다른 PC는 따로 셈');
});

test('가성비 배수·요금제 순위·스티커(기준 Max 5x)·이상치 제외', async () => {
  // Max 5x 4계정: 주간 3%p씩. 비용 $6×(개수) — 1%당 $6/2=3 → 100% $300 ... 계정마다 다르게
  const five = [['5', 2], ['6', 3], ['7', 4], ['8', 400]]; // '8'은 극단값 → 이상치
  for (const [c, mult] of five) {
    const body = interval({ account_fp: fp(c), g_start: 0, g_end: 3, tokens_by_model: { 'claude-opus-5-5': { ...zero, input: 1_000_000 * mult } } });
    assert.equal((await post(srv.base, aliceToken, body)).body.status, 'accepted');
  }
  for (const [c, mult] of [['b', 5], ['c', 5]]) {
    const body = interval({ account_fp: fp(c), tier: 'default_claude_max_20x', g_start: 0, g_end: 3, tokens_by_model: { 'claude-opus-5-5': { ...zero, input: 1_000_000 * mult } } });
    assert.equal((await post(srv.base, bobToken, body)).body.status, 'accepted');
  }
  const s = await (await fetch(`${srv.base}/api/stats`)).json();
  const m5 = s.plans.max5x, m20 = s.plans.max20x;
  // 이상치 '8' 제외 → '5','6','7' (+ 앞 테스트의 fp('1') $6/2%p=300/100%·fp('2')는 주간 3%p이므로 포함)
  const ranked = s.ranking.max5x;
  assert.ok(!ranked.some(r => r.tag === '8888'), '이상치는 순위 제외');
  assert.equal(m5.n, ranked.length);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].value_multiple >= ranked[i].value_multiple);
  assert.ok(Math.abs(m5.value_multiple - m5.mean_usd_per_100pct * 30 / 7 / 100) < 1e-9);
  // 20x: 1%당 $20/3... 100% = 5*4/3*100
  assert.ok(Math.abs(m20.mean_usd_per_100pct - 5 * 4 / 3 * 100) < 1e-9);
  assert.equal(s.baseline, 'max5x');
  const st20 = s.stickers.max20x.map(t => t.text);
  assert.ok(st20.some(t => /^가격 2배 → 가치 /.test(t)));
  assert.ok(s.stickers.max5x.some(t => t.kind === 'baseline'));
  assert.deepEqual(s.stickers.pro.map(t => t.text), ['측정 대기 · 통계 반영 0/2']);
  assert.equal(s.stickers[m20.value_multiple > m5.value_multiple ? 'max20x' : 'max5x'].some(t => t.kind === 'best'), true);
  // 공개 응답에 계정 지문 전체·사용자 ID가 없어야 함
  const text = JSON.stringify(s) + JSON.stringify(await (await fetch(`${srv.base}/api/feed`)).json());
  assert.ok(!text.includes('a'.repeat(64)) && !text.includes(fp('5')) && !/user_id/.test(text));
});

test('/me: 내 순위·상위 %·실효 단가·평균 대비', async () => {
  const me = await (await fetch(`${srv.base}/me.json`, { headers: { cookie: alice } })).json();
  const a = me.accounts.find(x => x.tag === '5555');
  assert.ok(a.rank >= 1 && a.top_pct >= 1 && a.top_pct <= 100);
  assert.ok(Math.abs(a.effective_usd_per_api_usd - 100 / a.monthly_value) < 1e-12);
  assert.equal(typeof a.vs_plan_mean, 'number');
  assert.ok(me.accounts.find(x => x.tag === '8888').ineligible === 'outlier');
  const csv = await (await fetch(`${srv.base}/me/export.csv`, { headers: { cookie: alice } })).text();
  assert.match(csv, /interval_id,account_tag,gauge/);
});

test('스티커 순수 로직: 가치 배수가 가격 배수의 80% 미만이면 광고보다 적음, Pro가 차면 기준 전환', () => {
  const P = (plan, price, n, monthly) => ({ plan, price, n, min_accounts: 5, shown: n >= 5, monthly_value: monthly, value_multiple: monthly / price });
  const a = stickers({ pro: P('pro', 20, 1, 0), max5x: P('max5x', 100, 5, 5000), max20x: P('max20x', 200, 5, 7000) });
  assert.equal(a.baseline, 'max5x');
  assert.ok(a.stickers.max20x.some(t => t.text === '가격 2배 → 가치 1.4배'));
  assert.ok(a.stickers.max20x.some(t => t.kind === 'less'));
  assert.ok(a.stickers.max5x.some(t => t.kind === 'best'));
  const b = stickers({ pro: P('pro', 20, 5, 1000), max5x: P('max5x', 100, 5, 5000), max20x: P('max20x', 200, 5, 10000) });
  assert.equal(b.baseline, 'pro');
  assert.ok(b.stickers.max5x.some(t => t.text === '가격 5배 → 가치 5배'));
  assert.ok(!b.stickers.max5x.some(t => t.kind === 'less'));
});

test('내 데이터 삭제 후 통계·순위에서 빠진다', async () => {
  const carol = await login(srv.base, 'carol');
  const tok = (await linkDevice(srv.base, carol)).token.device_token;
  await post(srv.base, tok, interval({ account_fp: fp('d'), g_start: 0, g_end: 3 }));
  let s = await (await fetch(`${srv.base}/api/stats`)).json();
  assert.ok(s.ranking.max5x.some(r => r.tag === 'dddd'));
  const csrf = await csrfOf(srv.base, carol, '/me');
  const del = await fetch(`${srv.base}/me/delete`, { method: 'POST', redirect: 'manual', headers: { cookie: carol, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, confirm: 'DELETE' }) });
  assert.equal(del.status, 302);
  s = await (await fetch(`${srv.base}/api/stats`)).json();
  assert.ok(!s.ranking.max5x.some(r => r.tag === 'dddd'));
  assert.equal((await post(srv.base, tok, interval({ account_fp: fp('d'), g_start: 5, g_end: 6 }))).status, 401);
});
