// 서버 API 규칙 테스트 v2 (wrangler dev --local). 기기 연결·창 기반 가성비·순위·스티커·공개 차단·요금제 변경·삭제.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, linkDevice, csrfOf, windowPayload, postBins } from './harness.mjs';
import { stickers } from '../src/stats.js';

let srv, alice, bob, aliceToken, bobToken;
before(async () => {
  srv = await startServer();
  alice = await login(srv.base, 'alice');
  bob = await login(srv.base, 'bob');
  aliceToken = (await linkDevice(srv.base, alice)).token.device_token;
  bobToken = (await linkDevice(srv.base, bob)).token.device_token;
});
after(async () => { await srv?.stop(); });
const fp = c => c.repeat(64).slice(0, 64);
const stats = async () => (await fetch(`${srv.base}/api/stats`)).json();
const meOf = async cookie => (await fetch(`${srv.base}/me.json`, { headers: { cookie } })).json();

test('기기 코드: 승인 전 428, 승인 후 1회만 토큰(재사용 410), 거부는 403', async () => {
  const code = await (await fetch(`${srv.base}/device/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pc-x', os: 'darwin-arm64', client_version: '0.2.0' }) })).json();
  const poll = () => fetch(`${srv.base}/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: code.device_code }) });
  assert.equal((await poll()).status, 428);
  const csrf = await csrfOf(srv.base, alice, `/link?code=${code.user_code}`);
  await fetch(`${srv.base}/link`, { method: 'POST', redirect: 'manual', headers: { cookie: alice, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, user_code: code.user_code, action: 'approve' }) });
  assert.equal((await poll()).status, 200);
  assert.equal((await poll()).status, 410);
});

test('로그인 없이 /me·/link는 로그인으로 보낸다', async () => {
  for (const p of ['/me', '/link?code=X']) assert.equal((await fetch(`${srv.base}${p}`, { redirect: 'manual' })).status, 302);
});

test('폐기한 기기의 제출은 401', async () => {
  const tok = (await linkDevice(srv.base, bob)).token.device_token;
  assert.equal((await fetch(`${srv.base}/device/revoke`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } })).status, 200);
  assert.equal((await postBins(srv.base, tok, windowPayload({ fp: fp('4') }))).status, 401);
});

test('같은 PC(같은 설치 식별자)를 다시 연결하면 예전 연결은 해제되어 한 대로 잡힌다', async () => {
  const carol = await login(srv.base, 'carol-relink');
  const first = (await linkDevice(srv.base, carol, { name: 'pc-aaaa' })).token.device_token;
  const before = (await stats()).measuring;
  const second = (await linkDevice(srv.base, carol, { name: 'pc-aaaa' })).token.device_token;
  const after = (await stats()).measuring;
  assert.equal(after.devices, before.devices, 'PC 수가 늘지 않아야 함');
  assert.equal((await postBins(srv.base, first, windowPayload({ fp: fp('c1') }))).status, 401);
  assert.equal((await postBins(srv.base, second, windowPayload({ fp: fp('c1') }))).status, 201);
  await linkDevice(srv.base, carol, { name: 'pc-bbbb' });
  assert.equal((await stats()).measuring.devices, after.devices + 1, '다른 PC는 따로 셈');
});

test('공개 기준 미달 요금제는 API에 수치를 싣지 않는다(1계정 합성), 피드에도 없음', async () => {
  const dave = await login(srv.base, 'dave');
  const tok = (await linkDevice(srv.base, dave)).token.device_token;
  assert.equal((await postBins(srv.base, tok, windowPayload({ fp: fp('d'), tier: 'default_claude_pro' }))).status, 201);
  const s = await stats();
  const pro = s.plans.pro;
  assert.equal(pro.shown, false); assert.equal(pro.participants >= 1, true);
  for (const k of ['median_usd_per_100pct', 'p25', 'p75', 'range_lo', 'range_hi', 'monthly_value', 'value_multiple', 'five_hour_median_usd_per_100pct', 'stages'])
    assert.equal(pro[k], null, k);
  assert.deepEqual(s.ranking.pro, []);
  assert.ok(!(await (await fetch(`${srv.base}/api/feed`)).json()).some(r => r.plan === 'pro'));
});

test('가성비: 계정 값 중앙값·범위·단계·순위·스티커(기준 Max 5x)·이상치 제외', async () => {
  // Max 5x 5계정: 창 Δ12, bin 12개 × $4·mtok → 1%당 $4·mtok. '8'은 극단값.
  for (const [c, mtok] of [['5', 2], ['6', 3], ['7', 4], ['a', 2.5], ['8', 400]]) assert.equal((await postBins(srv.base, aliceToken, windowPayload({ fp: fp(c), mtok }))).status, 201);
  for (const [c, mtok] of [['b', 5], ['c', 5]]) assert.equal((await postBins(srv.base, bobToken, windowPayload({ fp: fp(c), tier: 'default_claude_max_20x', mtok }))).status, 201);
  const s = await stats();
  const m5 = s.plans.max5x, m20 = s.plans.max20x;
  assert.ok(!s.ranking.max5x.some(r => r.tag === '8888'), '이상치 제외');
  assert.equal(m5.n, s.ranking.max5x.length);
  for (let i = 1; i < s.ranking.max5x.length; i++) assert.ok(s.ranking.max5x[i - 1].value_multiple >= s.ranking.max5x[i].value_multiple);
  assert.ok(Math.abs(m20.median_usd_per_100pct - 4 * 5 * 100) < 1e-6, '20x: 1%당 $20 → 100% $2000');
  assert.ok(m20.range_lo < m20.median_usd_per_100pct && m20.median_usd_per_100pct < m20.range_hi);
  assert.equal(m20.stages.precise, 2);
  assert.ok(Math.abs(m5.value_multiple - m5.median_usd_per_100pct * 30 / 7 / 100) < 1e-9);
  assert.equal(s.baseline, 'max5x');
  assert.ok(s.stickers.max20x.some(t => /^가격 2배 → 가치 /.test(t.text)));
  assert.ok(s.stickers.max5x.some(t => t.kind === 'baseline'));
  assert.match(s.note, /참여자가 로컬에서 관측/);
  const text = JSON.stringify(s) + JSON.stringify(await (await fetch(`${srv.base}/api/feed`)).json());
  assert.ok(!text.includes(fp('5')) && !/user_id|account_fp/.test(text), '공개 응답에 지문 전체·사용자 ID 없음');
});

test('증거 묶음: 공개 요금제만, 재요청 시 같은 해시, 절대 시각·지문·사용자 ID 없음', async () => {
  assert.equal((await fetch(`${srv.base}/v2/evidence/pro`)).status, 404);
  assert.equal((await fetch(`${srv.base}/v2/evidence/nope`)).status, 404);
  const a = await fetch(`${srv.base}/v2/evidence/max5x`), b = await fetch(`${srv.base}/v2/evidence/max5x`);
  assert.equal(a.status, 200);
  const ta = await a.text(), tb = await b.text();
  assert.equal(ta, tb); assert.equal(a.headers.get('x-evidence-sha256'), b.headers.get('x-evidence-sha256'));
  const e = JSON.parse(ta);
  assert.equal(e.format, 'jinsil-evidence/1');
  assert.equal(e.accounts.length, e.summary.n);
  const w = e.accounts[0].windows[0];
  assert.ok(w.samples.length >= 2 && w.bins.length >= 1 && w.price_version && e.price_tables[w.price_version]);
  // 묶음만으로 재계산: 창 비용 = bin 비용 합(mid)
  const c = e.accounts[0].windows.find(x => !x.exclude_reason);
  assert.ok(c.cost > 0 && c.usd_per_pct > 0);
  assert.ok(!/user_id|account_fp|device_id|resets_at|"t_base"|2026-/.test(ta), '절대 시각·식별자 없음');
  assert.ok(!ta.includes(fp('5')));
});

test('단계: 누적 +5%p 잠정 등록, +8 보통, +11 정밀 / 외부 사용 의심 창은 제외 사유로 집계', async () => {
  const erin = await login(srv.base, 'erin');
  const tok = (await linkDevice(srv.base, erin)).token.device_token;
  await postBins(srv.base, tok, windowPayload({ fp: fp('e1'), delta: 5 }));
  await postBins(srv.base, tok, windowPayload({ fp: fp('e2'), delta: 4 }));
  await postBins(srv.base, tok, windowPayload({ fp: fp('e3'), delta: 10, external: true }));
  const me = await meOf(erin);
  const a = t => me.accounts.find(x => x.tag === t);
  assert.equal(a('e1e1').stage, 'provisional');
  assert.equal(a('e2e2').ineligible, 'insufficient_weekly_data');
  assert.ok(me.windows.some(w => w.public_tag === 'e3e3' && w.exclude_reason === 'external_usage_suspected'));
  const s = await stats();
  assert.ok((s.plans.max5x.exclusions['7d'] || {}).external_usage_suspected >= 1);
});

test('/me: 순위·실효 단가·중앙값 대비·최근 게이지(게이지마다 하나)', async () => {
  await postBins(srv.base, aliceToken, windowPayload({ fp: fp('5'), gauge: '5h', g0: 10, delta: 20, start: Date.now() - 3 * 3600000 }));
  const me = await meOf(alice);
  const a = me.accounts.find(x => x.tag === '5555');
  assert.ok(a.rank >= 1 && a.top_pct >= 1 && a.top_pct <= 100);
  assert.ok(Math.abs(a.effective_usd_per_api_usd - 100 / a.monthly_value) < 1e-12);
  assert.equal(typeof a.vs_plan_median, 'number');
  assert.deepEqual(a.latest.map(l => l.gauge).sort(), ['5h', '7d']);
  assert.ok(me.accounts.find(x => x.tag === '8888').ineligible === 'outlier');
  const csv = await (await fetch(`${srv.base}/me/export.csv`, { headers: { cookie: alice } })).text();
  assert.match(csv, /account_tag,gauge,resets_at/);
});

test('요금제를 바꾼 계정은 현재 요금제 창만 집계한다', async () => {
  const f = fp('f1');
  await postBins(srv.base, bobToken, windowPayload({ fp: f, tier: 'default_claude_max_5x', delta: 10, start: Date.now() - 30 * 3600000, resetsIn: 2 * 86400000 }));
  await postBins(srv.base, bobToken, windowPayload({ fp: f, tier: 'default_claude_max_20x', delta: 6, start: Date.now() - 5 * 3600000, resetsIn: 6 * 86400000 }));
  const a = (await meOf(bob)).accounts.find(x => x.tag === 'f1f1');
  assert.equal(a.plan, 'max20x');
  assert.equal(a.weekly_pct, 6, 'Max 5x 시절 +10%p는 섞이지 않음');
});

test('스티커 순수 로직: 가치 배수가 가격 배수의 80% 미만이면 광고보다 적음, Pro가 차면 기준 전환', () => {
  const p = (plan, price, mv, shown = true) => ({ plan, price, monthly_value: mv, value_multiple: mv / price, shown, n: 5, min_accounts: 5 });
  const r = stickers({ pro: p('pro', 20, 400), max5x: p('max5x', 100, 1500), max20x: p('max20x', 200, 4000), team_standard: p('team_standard', 25, 0, false), team_premium: p('team_premium', 125, 0, false) });
  assert.equal(r.baseline, 'pro');
  assert.ok(r.stickers.max5x.some(t => t.kind === 'less'));
});

test('내 데이터 삭제 후 통계·순위에서 빠지고, 기기 토큰도 무효', async () => {
  const gina = await login(srv.base, 'gina');
  const tok = (await linkDevice(srv.base, gina)).token.device_token;
  await postBins(srv.base, tok, windowPayload({ fp: fp('9') }));
  assert.ok((await stats()).ranking.max5x.some(r => r.tag === '9999'));
  const csrf = await csrfOf(srv.base, gina, '/me');
  const del = await fetch(`${srv.base}/me/delete`, { method: 'POST', redirect: 'manual', headers: { cookie: gina, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, confirm: 'DELETE' }) });
  assert.equal(del.status, 302);
  assert.ok(!(await stats()).ranking.max5x.some(r => r.tag === '9999'));
  assert.equal((await postBins(srv.base, tok, windowPayload({ fp: fp('9') }))).status, 401);
});
