// 게이지 샘플러: 5분 간격·유휴 중단·429 대기·401 중단·목적지 고정·토큰 비노출. 창 계산기: 범위·단계·제외 규칙.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSampler, getJson, POLL_MS } from '../src/gauge.mjs';
import { computeWindows } from '../src/window.mjs';

const TOKEN = 'tok' + '-' + 'x'.repeat(12);
const okUsage = { status: 200, json: { five_hour: { utilization: 12, resets_at: '2030-01-01T05:00:00Z' }, seven_day: { utilization: 30, resets_at: '2030-01-07T00:00:00Z' } } };
const profile = { status: 200, json: { account: { uuid: 'u-1' }, organization: { rate_limit_tier: 'default_claude_max_5x' } } };
function fake(seq) {
  const calls = [];
  const get = async (p, tok) => { calls.push(p); assert.equal(tok, TOKEN); return p.endsWith('profile') ? profile : seq.shift() || okUsage; };
  return { get, calls };
}

test('최초 1회 기준 샘플, 이후 5분 간격, 유휴(활동 없음)면 폴링 안 함', async () => {
  let t = 1_000_000_000_000;
  const { get, calls } = fake([]);
  const s = createSampler({ readToken: async () => ({ token: TOKEN }), get, refresh: async () => true, now: () => t });
  const first = await s.tick(0);
  assert.equal(first.account_fp.length, 64); assert.equal(first.seven_day.utilization, 30); assert.equal(first.tier, 'default_claude_max_5x');
  t += 60000; assert.equal(await s.tick(t), null, '5분 안 됨');
  t += POLL_MS; assert.ok(await s.tick(t - 1000), '활동 중이면 5분마다');
  t += 3 * 3600000; assert.equal(await s.tick(t - 3 * 3600000), null, '오래 유휴면 안 함');
  assert.ok(!JSON.stringify(first).includes(TOKEN));
  assert.equal(calls.filter(c => c.endsWith('usage')).length, 2);
});

test('429는 대기(새 활동도 우회 못 함), 401은 갱신 1회 후 중단', async () => {
  let t = 2_000_000_000_000;
  const { get } = fake([{ status: 429, json: null, retryAfter: 1200 }]);
  const s = createSampler({ readToken: async () => ({ token: TOKEN }), get, refresh: async () => true, now: () => t });
  assert.equal(await s.tick(t), null); assert.equal(s.state.status, 'rate_limited');
  t += POLL_MS + 1000; assert.equal(await s.tick(t), null, 'retry-after 1200초 전');
  t += 1200 * 1000; assert.ok(await s.tick(t));
  let refreshed = 0;
  const f2 = fake([{ status: 401 }, { status: 401 }]);
  const s2 = createSampler({ readToken: async () => ({ token: TOKEN }), get: f2.get, refresh: async () => { refreshed++; return true; }, now: () => t });
  assert.equal(await s2.tick(t), null);
  assert.equal(refreshed, 1); assert.equal(s2.state.status, 'reauth_needed');
  t += POLL_MS * 2; assert.equal(await s2.tick(t), null); assert.equal(refreshed, 1, '같은 토큰이면 다시 시도 안 함');
});

test('목적지는 api.anthropic.com 고정', async () => {
  let opts;
  const request = (o, cb) => { opts = o; const req = new EventEmitter(); req.end = () => { const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; cb(res); res.emit('data', '{}'); res.emit('end'); }; return req; };
  await getJson('/api/oauth/usage', TOKEN, { request });
  assert.equal(opts.hostname, 'api.anthropic.com'); assert.equal(opts.port, 443);
});

const H = 3600000, T0 = Date.parse('2026-09-24T00:00:00Z'), R = '2026-09-30T00:00:00Z';
const smp = (t, u, tier = 'default_claude_max_5x') => ({ observed_at: T0 + t, gauge: '7d', utilization: u, resets_at: R, tier });
const bin = (t, cost) => ({ bin_start: T0 + t, cost, unpriced: false });

test('창: 기준점~최댓값 도달 사이 비용, 범위 [C⁻/(D+1), C⁺/(D−1)], 단계 5/8/11', () => {
  const samples = [smp(0, 10), smp(H, 16), smp(2 * H, 22), smp(2 * H + 10 * 60000, 22)];
  const bins = [];
  for (let m = 5; m < 120; m += 5) bins.push(bin(m * 60000, 1));
  const [w] = computeWindows({ samples, bins, now: T0 + 5 * H });
  assert.equal(w.delta, 12); assert.equal(w.stage, 'precise');
  assert.equal(w.exclude_reason, null);
  assert.ok(Math.abs(w.usd_per_pct - w.cost / 12) < 1e-6);
  assert.ok(w.usd_per_pct_lo <= w.usd_per_pct && w.usd_per_pct <= w.usd_per_pct_hi);
  assert.ok(Math.abs(w.usd_per_pct_lo - w.cost_lo / 13) < 1e-6 && Math.abs(w.usd_per_pct_hi - w.cost_hi / 11) < 1e-6);
  assert.equal(w.state, 'final', '마지막 두 샘플 불변 + 활동 뒤 30분');
  const stage = d => computeWindows({ samples: [smp(0, 0), smp(H, d)], bins: [bin(30 * 60000, 1)], now: T0 + 2 * H })[0];
  assert.equal(stage(4).exclude_reason, 'below_min_delta');
  assert.equal(stage(5).stage, 'provisional'); assert.equal(stage(8).stage, 'normal'); assert.equal(stage(11).stage, 'precise');
});

test('창 제외: 로컬 사용 없이 상승=외부 사용 의심, 요금제 변경', () => {
  const ext = computeWindows({ samples: [smp(0, 10), smp(H, 20), smp(3 * H, 30)], bins: [bin(30 * 60000, 5)], now: T0 + 4 * H })[0];
  assert.equal(ext.exclude_reason, 'external_usage_suspected');
  const tc = computeWindows({ samples: [smp(0, 10), smp(H, 20, 'default_claude_max_20x')], bins: [bin(30 * 60000, 5)], now: T0 + 2 * H })[0];
  assert.equal(tc.exclude_reason, 'tier_changed');
});

test('토큰 파일(.credentials.json): Linux·Windows는 파일, macOS는 키체인 없을 때만 파일로 폴백', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { readClaudeToken } = await import('../src/keychain.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-cred-'));
  const file = path.join(d, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 123 } }));
  for (const platform of ['linux', 'win32']) {
    const r = await readClaudeToken({ platform, file });
    assert.equal(r.token, TOKEN); assert.equal(r.source, 'file');
  }
  const viaKeychain = await readClaudeToken({ platform: 'darwin', file, run: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'kc' } }) });
  assert.equal(viaKeychain.source, 'keychain');
  const fallback = await readClaudeToken({ platform: 'darwin', file, run: async () => null });
  assert.equal(fallback.source, 'file');
  assert.equal((await readClaudeToken({ platform: 'linux', file: path.join(d, 'none.json') })).token, null);
});

test('Windows 자동 실행 스크립트: 콘솔 없이 수집기를 띄우고 죽으면 다시 띄운다(따옴표 이스케이프)', async () => {
  const { winScriptContent, winRunCommand } = await import('../src/service.mjs');
  const s = winScriptContent({ node: 'C:\\Program Files\\nodejs\\node.exe', entry: "C:\\Users\\o'k\\.jinsil\\app\\0.2.0\\bin\\jinsil.mjs" });
  assert.match(s, /while \(\$true\)/); assert.match(s, /collector/); assert.match(s, /o''k/);
  assert.match(winRunCommand(), /-WindowStyle Hidden/);
});
