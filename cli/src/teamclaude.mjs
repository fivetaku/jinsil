// 계정 풀(teamclaude) 모드: 요청 경로에 끼지 않고, 풀이 남기는 요청별 로그와 풀의 계정 목록을 읽는다(0.2.2).
// - 대화 파일에는 어느 계정으로 나갔는지가 없다(모델명·토큰·시각만). 풀은 요청마다 계정을 바꾸므로 시각만으로 귀속할 수 없다.
// - 토큰: teamclaude-usage.tsv(ts, 계정, 모델, 입력, 출력, 캐시합계, 캐시읽기, u5h, u7d, …). 줄은 스트림 이벤트 단위라 합산하면 요청 합과 같다.
// - 캐시 쓰기 TTL(5분/1시간)은 로그에 없다 → 5분으로 가정(teamclaude 자체 정산과 같음). 가정은 제출 수집기 이름('teamclaude')으로 창에 남는다.
// - 게이지: 풀 설정의 각 OAuth 계정 토큰으로 /api/oauth/usage·profile을 5분마다(활동 계정만) 조회. 목적지는 api.anthropic.com 고정(gauge.mjs getJson).
//   토큰은 메모리에서만 쓰고 저장·전송하지 않는다. 풀 설정은 읽기만 한다(수정 금지).
// - 계정 지문 = sha256('jinsil/v1/' + accountUuid) — 무개입·프록시 모드와 같은 값.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { accountFingerprint } from './recorder.mjs';
import { getJson, POLL_MS, ACTIVE_MS } from './gauge.mjs';
import { PRICES } from './prices.mjs';

export const poolConfigPath = () => process.env.JINSIL_TEAMCLAUDE_CONFIG || path.join(os.homedir(), '.config', 'teamclaude.json');
export const poolLogPath = () => process.env.JINSIL_TEAMCLAUDE_LOG || path.join(os.homedir(), 'Library', 'Logs', 'teamclaude-usage.tsv');

// 풀의 OAuth 계정 목록: 이름 → {fp, token}. 비활성 계정도 지문은 만든다(과거 로그 귀속용), 토큰은 활성만.
// only: 수집할 계정 이름 목록(로컬 설정 pool_accounts). 비우면 풀의 OAuth 계정 전부.
export function readPool(file = poolConfigPath(), only = null) {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const out = new Map();
  for (const a of cfg.accounts || []) {
    if (a.type !== 'oauth' || typeof a.accountUuid !== 'string' || typeof a.name !== 'string') continue;
    if (only?.length && !only.includes(a.name)) continue;
    out.set(a.name, { fp: accountFingerprint(a.accountUuid), token: !a.disabled && typeof a.accessToken === 'string' ? a.accessToken : null });
  }
  return out;
}

const n = v => { const x = Number(v); return Number.isInteger(x) && x >= 0 ? x : 0; };

// 로그 증분 읽기. state: { ino, offset, messages: {key: rec}, excluded: {} }
export function scanPoolLog(state, { file = poolLogPath(), pool, since = 0, now = Date.now(), keepMs = 8 * 86400000 } = {}) {
  state.messages ||= {}; state.excluded ||= {};
  let st; try { st = fs.statSync(file); } catch { return 0; }
  let offset = state.ino === st.ino && st.size >= (state.offset || 0) ? state.offset || 0 : 0;
  // 처음 읽을 때 연결 이전 구간은 건너뛴다(큰 로그 대비): 끝에서 역으로 찾지 않고 줄 단위로 걸러낸다.
  let changed = 0;
  if (offset < st.size) {
    const fd = fs.openSync(file, 'r');
    try {
      const CHUNK = 4 << 20;
      let carry = '';
      while (offset < st.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - offset));
        fs.readSync(fd, buf, 0, buf.length, offset);
        const text = carry + buf.toString('utf8');
        const end = text.lastIndexOf('\n');
        offset += buf.length;
        if (end < 0) { carry = text; continue; }
        carry = text.slice(end + 1);
        for (const line of text.slice(0, end).split('\n')) {
          const c = line.split('\t');
          const ts = Number(c[0]);
          if (!Number.isFinite(ts) || c.length < 7) continue;
          if (ts < since) continue;
          const acct = pool.get(c[1]);
          if (!acct) { state.excluded.not_oauth_account = (state.excluded.not_oauth_account || 0) + 1; continue; }
          if (!Object.hasOwn(PRICES, c[2])) { state.excluded.nonstandard_model = (state.excluded.nonstandard_model || 0) + 1; continue; }
          const input = n(c[3]), output = n(c[4]), total = n(c[5]), cr = n(c[6]);
          const key = createHash('sha256').update(line).digest('hex').slice(0, 20);
          if (state.messages[key]) continue;
          state.messages[key] = { key, ts, model: c[2], account_fp: acct.fp,
            tokens: { input, output, cache_read: cr, cache_write_5m: Math.max(0, total - cr), cache_write_1h: 0, cache_write_unknown: 0 }, special: {}, sidechain: false };
          changed++;
        }
      }
      offset -= Buffer.byteLength(carry, 'utf8'); // 쓰는 중인 마지막 줄은 다음에 다시 읽는다
    } finally { fs.closeSync(fd); }
  }
  state.ino = st.ino; state.offset = offset;
  for (const [k, r] of Object.entries(state.messages)) if (now - r.ts > keepMs) delete state.messages[k];
  return changed;
}

const bucket = b => (b && Number.isFinite(b.utilization) && Number.isFinite(Date.parse(b.resets_at))) ? { utilization: b.utilization, resets_at: b.resets_at } : null;

// 계정별 게이지 샘플러. 활동 계정(최근 30분 + 후속 관측)만, 계정마다 5분 간격·429 대기. 401은 풀이 토큰을 갱신할 때까지 건너뛴다.
export function createPoolSampler({ get = getJson, now = () => Date.now() } = {}) {
  const per = new Map(); // fp → { lastPoll, nextAllowed, backoff, tier, tierAt, status }
  async function tick(pool, lastActivityByFp) {
    const out = [];
    for (const [, a] of pool) {
      if (!a.token) continue;
      const t = now();
      const s = per.get(a.fp) || per.set(a.fp, { lastPoll: 0, nextAllowed: 0, backoff: POLL_MS, tier: null, tierAt: 0, status: 'idle' }).get(a.fp);
      const first = s.lastPoll === 0, last = lastActivityByFp.get(a.fp) || 0;
      if (!first && t - last > ACTIVE_MS + POLL_MS) { s.status = 'idle'; continue; }
      if (first && !last) continue; // 이 PC에서 쓴 적 없는 계정은 조회하지 않는다
      if (t < s.nextAllowed || (!first && t - s.lastPoll < POLL_MS)) continue;
      s.lastPoll = t;
      if (!s.tier || t - s.tierAt > 3600000) {
        const p = await get('/api/oauth/profile', a.token);
        if (p.status === 200 && typeof p.json?.organization?.rate_limit_tier === 'string') { s.tier = p.json.organization.rate_limit_tier; s.tierAt = t; }
      }
      const r = await get('/api/oauth/usage', a.token);
      if (r.status === 429) { s.nextAllowed = t + (r.retryAfter ? r.retryAfter * 1000 : s.backoff); s.backoff = Math.min(s.backoff * 2, 3600000); s.status = 'rate_limited'; continue; }
      if (r.status !== 200 || !r.json) { s.status = `http_${r.status}`; s.nextAllowed = t + POLL_MS; continue; }
      s.backoff = POLL_MS; s.status = 'ok';
      const five = bucket(r.json.five_hour), seven = bucket(r.json.seven_day);
      if (five || seven) out.push({ observed_at: t, account_fp: a.fp, tier: s.tier, source: 'usage_api', five_hour: five, seven_day: seven });
    }
    return out;
  }
  return { tick, state: per };
}

export function lastActivityByFp(state) {
  const m = new Map();
  for (const r of Object.values(state.messages || {})) if (r.ts > (m.get(r.account_fp) || 0)) m.set(r.account_fp, r.ts);
  return m;
}
