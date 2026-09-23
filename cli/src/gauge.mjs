// 게이지 샘플러: 키체인 계정의 /api/oauth/usage를 5분 간격으로 읽는다.
// - 목적지는 https://api.anthropic.com 고정(설정·환경변수로 바꿀 수 없음). 토큰은 메모리에서만.
// - 폴링 조건: 최초 기준 샘플 1회, 이후 최근 30분 안에 사용이 있거나 마지막 사용 뒤 30분의 후속 관측 기간.
// - 429: retry-after 또는 지수 대기(5→10→20→40→60분). 새 활동이 대기를 우회하지 않는다.
// - 401: Claude Code에 갱신을 맡긴 뒤 1회 재시도, 그래도 401이면 토큰이 바뀔 때까지 중단(reauth_needed). 다른 계정 항목 순회 금지.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { accountFingerprint } from './recorder.mjs';
import { tierFromProfile } from './tiers.mjs';
import { readClaudeToken, refreshViaClaude } from './keychain.mjs';

const HOST = 'api.anthropic.com';
export const POLL_MS = 5 * 60000;
export const ACTIVE_MS = 30 * 60000;

export function getJson(pathname, token, { request = https.request } = {}) {
  return new Promise(resolve => {
    const r = request({ hostname: HOST, port: 443, path: pathname, method: 'GET', timeout: 15000,
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json', 'user-agent': 'jinsil' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (body.length < 1 << 20) body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json, retryAfter: Number(res.headers['retry-after']) || null }); });
    });
    r.on('timeout', () => r.destroy(Error('timeout')));
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end();
  });
}

const bucket = b => (b && Number.isFinite(b.utilization) && Number.isFinite(Date.parse(b.resets_at))) ? { utilization: b.utilization, resets_at: b.resets_at } : null;

export function createSampler({ readToken = readClaudeToken, refresh = refreshViaClaude, get = getJson, now = () => Date.now() } = {}) {
  const st = { lastPoll: 0, nextAllowed: 0, backoff: POLL_MS, status: 'idle', tokenHash: null, profile: null, blockedHash: null };
  const hashOf = t => createHash('sha256').update(t).digest('hex');

  async function profileFor(token) {
    const h = hashOf(token);
    if (st.profile && st.profile.hash === h && now() - st.profile.at < 3600000) return st.profile;
    const r = await get('/api/oauth/profile', token);
    const uuid = r.json?.account?.uuid;
    if (r.status !== 200 || typeof uuid !== 'string') return { status: r.status };
    st.profile = { hash: h, at: now(), account_fp: accountFingerprint(uuid),
      tier: tierFromProfile(r.json) };
    return st.profile;
  }

  // lastActivityMs: 대화 파일에서 본 마지막 메시지 시각. 반환: 샘플 또는 null
  async function tick(lastActivityMs) {
    const t = now();
    const first = st.lastPoll === 0;
    const active = t - lastActivityMs <= ACTIVE_MS + POLL_MS; // 활동 중 또는 후속 관측 기간
    if (!first && !active) { st.status = 'idle'; return null; }
    if (t < st.nextAllowed || (!first && t - st.lastPoll < POLL_MS)) return null;
    let { token } = await readToken();
    if (!token) { st.status = 'no_token'; st.nextAllowed = t + POLL_MS; return null; }
    if (st.blockedHash && st.blockedHash === hashOf(token)) { st.status = 'reauth_needed'; return null; }
    st.lastPoll = t;
    let p = await profileFor(token);
    let r = p.account_fp ? await get('/api/oauth/usage', token) : { status: p.status };
    if (r.status === 401) {
      await refresh();
      ({ token } = await readToken());
      if (token) { p = await profileFor(token); r = p.account_fp ? await get('/api/oauth/usage', token) : { status: p.status }; }
      if (r.status === 401 || !token) { st.status = 'reauth_needed'; st.blockedHash = token ? hashOf(token) : null; return null; }
    }
    if (r.status === 429) {
      st.nextAllowed = t + (r.retryAfter ? r.retryAfter * 1000 : st.backoff);
      st.backoff = Math.min(st.backoff * 2, 60 * 60000); st.status = 'rate_limited'; return null;
    }
    if (r.status !== 200 || !r.json) { st.status = `http_${r.status}`; st.nextAllowed = t + POLL_MS; return null; }
    st.backoff = POLL_MS; st.status = 'ok'; st.blockedHash = null;
    const five = bucket(r.json.five_hour), seven = bucket(r.json.seven_day);
    if (!five && !seven) { st.status = 'no_buckets'; return null; }
    return { observed_at: t, account_fp: p.account_fp, tier: p.tier, source: 'usage_api', five_hour: five, seven_day: seven };
  }
  return { tick, state: st };
}
