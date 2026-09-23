// wrangler dev --local 테스트 하니스: 임시 D1에 마이그레이션 적용 → 서버 기동 → 모의 IdP 로그인·기기 연결 도우미.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.resolve(serverDir, '..', 'node_modules', '.bin', 'wrangler');

async function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

export async function startServer(vars = {}, { persist } = {}) {
  const dir = persist || fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-srv-'));
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', dir], { cwd: serverDir, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  const port = await freePort();
  const all = { DEV_IDP: '1', GOOGLE_CLIENT_ID: 'dev-client', GOOGLE_AUTH_URL: '/dev-idp/authorize', GOOGLE_TOKEN_URL: '/dev-idp/token',
    PROBATION_HOURS: '0', MIN_ACCOUNTS: '2', ...vars };
  const args = ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--local-upstream', `127.0.0.1:${port}`, '--persist-to', dir, '--show-interactive-dev-session=false', '--test-scheduled'];
  for (const [k, v] of Object.entries(all)) args.push('--var', `${k}:${v}`);
  const child = spawn(wrangler, args, { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    try { const r = await fetch(`${base}/api/stats`); if (r.status === 200) break; } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw Error(`wrangler dev failed:\n${log.slice(-2000)}`);
    await new Promise(r => setTimeout(r, 300));
  }
  return { base, dir, child, log: () => log, stop: async () => { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); } };
}

const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));

// 모의 IdP로 로그인해 세션 쿠키를 받는다(실제 Google과 같은 /auth/google → /auth/callback 경로).
export async function login(base, sub) {
  const r1 = await fetch(`${base}/auth/google?next=/me`, { redirect: 'manual' });
  const oauth = cookieOf(r1, 'jinsil_oauth');
  const authorize = new URL(r1.headers.get('location'), base);
  authorize.searchParams.set('dev_sub', sub);
  const r2 = await fetch(authorize, { redirect: 'manual' });
  const r3 = await fetch(new URL(r2.headers.get('location'), base), { redirect: 'manual', headers: { cookie: oauth } });
  const session = cookieOf(r3, 'jinsil_session');
  if (!session) throw Error(`login failed ${r3.status}`);
  return session;
}
export async function csrfOf(base, cookie, pathname) {
  const t = await (await fetch(`${base}${pathname}`, { headers: { cookie } })).text();
  return /name="csrf" value="([^"]+)"/.exec(t)?.[1];
}
// CLI 기기 코드 흐름 전체
export async function linkDevice(base, cookie, { approve = true, name = `test-mac-${crypto.randomUUID().slice(0, 8)}` } = {}) {
  const c = await (await fetch(`${base}/device/code`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, os: 'darwin-arm64', client_version: '0.1.0' }) })).json();
  const pending = await fetch(`${base}/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: c.device_code }) });
  const csrf = await csrfOf(base, cookie, `/link?code=${c.user_code}`);
  const form = new URLSearchParams({ csrf, user_code: c.user_code, action: approve ? 'approve' : 'deny' });
  const decided = await fetch(`${base}/link`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const t = await fetch(`${base}/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: c.device_code }) });
  const again = await fetch(`${base}/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: c.device_code }) });
  return { code: c, pendingStatus: pending.status, decidedStatus: decided.status, tokenStatus: t.status, token: t.status === 200 ? (await t.json()) : null, againStatus: again.status };
}

const zero = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown: 0 };
let seq = 0;
export function interval(o = {}) {
  seq++;
  const hex = seq.toString(16).padStart(12, '0');
  return {
    interval_id: `00000000-0000-5000-8000-${hex}`, account_fp: 'a'.repeat(64), tier: 'default_claude_max_5x', gauge: '7d',
    reset_at: '2030-01-05T00:00:00.000Z', g_start: 1, g_end: 3, t_start: '2026-09-20T10:00:00.000Z', t_end: '2026-09-20T11:00:00.000Z',
    tokens_by_model: { 'claude-opus-5-5': { ...zero, input: 1_000_000, output: 100_000 } },
    boundary: { start_inflight_by_model: {}, end_inflight_by_model: {} }, requests: 10, quality: [], routed_upstream: false,
    client: { version: '0.1.0' }, ...o,
  };
}
export async function post(base, token, body) {
  const r = await fetch(`${base}/v1/intervals`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export { zero };

// v2: 한 계정의 한도 창 하나를 만드는 제출 묶음. 게이지 g0→g0+delta 사이 5분 bin마다 opus-5-5 입력 mtok백만 토큰(=$4×mtok).
const BIN = 300000;
export function windowPayload({ fp, tier = 'default_claude_max_5x', gauge = '7d', g0 = 0, delta = 12, mtok = 1, bins = 12, start = Date.now() - 20 * 3600000, resetsIn, external = false, collector = 'transcript' }) {
  const t0 = Math.floor(start / BIN) * BIN;
  const reset = new Date(t0 + (resetsIn ?? (gauge === '7d' ? 5 * 86400000 : 4 * 3600000))).toISOString();
  const samples = [{ observed_at: t0, gauge, utilization: g0, resets_at: reset, source: 'usage_api', tier }];
  const bs = [];
  if (!external) for (let i = 1; i <= bins; i++) bs.push({ bin_start: t0 + i * BIN, model: 'claude-opus-5-5', input: Math.round(mtok * 1e6), output: 0, cache_read: 0,
    cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown: 0, messages: 1, sidechain_messages: 0, special: {}, revision: (i.toString(16) + '0'.repeat(16)).slice(0, 16) });
  const tEnd = t0 + (bins + 1) * BIN;
  samples.push({ observed_at: tEnd, gauge, utilization: g0 + delta, resets_at: reset, source: 'usage_api', tier });
  samples.push({ observed_at: tEnd + 10 * 60000, gauge, utilization: g0 + delta, resets_at: reset, source: 'usage_api', tier });
  return { account_fp: fp, tier, bins: bs, samples, client: { version: '0.2.0', collector } };
}
export async function postBins(base, token, body) {
  const r = await fetch(`${base}/v2/bins`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
