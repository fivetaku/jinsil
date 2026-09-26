// 09-26 D1 rows read 대응: 계정별 재계산 스로틀. 스로틀된 서버(A)와 즉시 재계산 서버(B)에 같은 입력을 넣으면,
// A는 두 번째 제출을 미루고, 일 1회 cron 정리 뒤 /me 창·공개 통계가 B와 같아야 한다.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, linkDevice, windowPayload, postBins } from './harness.mjs';

let A, B;
before(async () => { A = await startServer({ RECOMPUTE_MIN_INTERVAL_S: '3600' }); B = await startServer(); });
after(async () => { await A?.stop(); await B?.stop(); });
const fp = c => c.repeat(64).slice(0, 64);
const T0 = Math.floor((Date.now() - 20 * 3600000) / 300000) * 300000;

async function feed(srv) {
  const cookie = await login(srv.base, 'tina');
  const tok = (await linkDevice(srv.base, cookie)).token.device_token;
  const full = windowPayload({ fp: fp('7a'), start: T0, delta: 12, mtok: 3 });
  const first = { ...full, bins: full.bins.slice(0, 5), samples: full.samples.slice(0, 1) };
  const second = { ...full, bins: full.bins.slice(5), samples: full.samples.slice(1) };
  const r1 = await postBins(srv.base, tok, first), r2 = await postBins(srv.base, tok, second);
  // 다른 계정 2개(공개 기준 MIN_ACCOUNTS=2)
  for (const [c, m] of [['7b', 2], ['7c', 4]]) await postBins(srv.base, tok, windowPayload({ fp: fp(c), start: T0, mtok: m }));
  return { cookie, r1, r2 };
}
const strip = ws => ws.map(({ updated_at, ...w }) => w).sort((x, y) => (x.public_tag + x.gauge).localeCompare(y.public_tag + y.gauge));
const meWindows = async (srv, cookie) => strip((await (await fetch(`${srv.base}/me.json`, { headers: { cookie } })).json()).windows);
const plans = async srv => (await (await fetch(`${srv.base}/api/stats`)).json()).plans;

test('스로틀: 새 계정 첫 제출은 즉시 재계산, 간격 안의 다음 제출은 미룸 → cron 정리 뒤 즉시 재계산과 결과 동일', async () => {
  const a = await feed(A), b = await feed(B);
  assert.equal(a.r1.body.recompute, 'done'); assert.equal(a.r2.body.recompute, 'deferred'); assert.equal(a.r2.body.windows, null);
  assert.equal(b.r2.body.recompute, 'done');
  const before = await meWindows(A, a.cookie);
  assert.notDeepEqual(before, await meWindows(B, b.cookie), '정리 전에는 미룬 제출분이 빠져 있음');
  // 같은 cron(단가 동기화 포함)을 양쪽에 돌려 단가 버전까지 맞춘 뒤 비교
  for (const srv of [A, B]) assert.equal((await fetch(`${srv.base}/__scheduled?cron=17+3+*+*+*`)).status, 200);
  assert.deepEqual(await meWindows(A, a.cookie), await meWindows(B, b.cookie));
  assert.deepEqual(await plans(A), await plans(B));
});
