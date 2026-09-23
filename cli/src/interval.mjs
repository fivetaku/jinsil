// 헤더 게이지 틱 기반 구간 계산 (로컬). 서버로 보낼 것은 구간 토큰·게이지·품질뿐이다.
//
// 틱: 같은 계정·같은 reset 창에서 응답 헤더의 정수 %가 이전 최댓값을 처음 넘은 응답의 헤더 수신 시각(ts_ms).
// 구간: 틱 A → 틱 B (5시간은 3%p 이상, 주간은 1%p 이상). 토큰은 완료 시각이 (A, B]인 요청의 합("완료 기준").
// 경계 불확실성: 각 틱 시각에 진행 중이던 요청의 토큰을 따로 보낸다(과금 시점이 시작/완료 어느 쪽인지 모름).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LEDGER_FILE, LIFECYCLE_FILE, COLUMNS } from './recorder.mjs';
import { TOKEN_KEYS, costOf, PRICES } from './prices.mjs';

export const MIN_TICKS = { '5h': 3, '7d': 1 };
// 이웃 관측 간 허용 최대 상승(%p). 넘으면 기록 공백으로 보고 구간을 잇지 않는다.
export const MAX_STEP = { '5h': 5, '7d': 2 };
export const GAP_MS = 3 * 60000;
const RESET_TOLERANCE_MS = 2000;
const PENDING_GRACE_MS = 10 * 60000;

const num = s => (s === '' || s === undefined || s === null || !Number.isFinite(Number(s))) ? null : Number(s);
const tok = s => { const n = num(s); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
export function normReset(s) {
  if (!s) return null;
  const n = num(s);
  const ms = n === null ? Date.parse(s) : n < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
// 헤더는 0~1 비율. 정수 %로 바꾼다(헤더 해상도가 1%p). 범위 밖이면 null.
export function pct(s) {
  const n = num(s);
  if (n === null || n < 0 || n > 1.5) return null;
  return Math.round(n * 100);
}

export function parseLedger(text) {
  const flags = new Set();
  if (!text.endsWith('\n')) flags.add('truncated_ledger_tail');
  const [head, ...lines] = text.replace(/\n+$/, '').split('\n'); // trimEnd는 끝 빈 열(탭)까지 지운다
  const cols = head.split('\t');
  if (cols.join('\t') !== COLUMNS.join('\t')) throw Error('ledger_schema_mismatch');
  const rows = lines.filter(Boolean).map(line => {
    const v = line.split('\t');
    const r = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    const q = new Set((r.quality || '').split(',').filter(f => f && f !== 'complete'));
    if (v.length !== cols.length) q.add('malformed_row');
    if (r.complete !== '1' || r.usage_observed !== '1') q.add('incomplete_usage');
    const tokens = Object.fromEntries(TOKEN_KEYS.map(k => [k, tok(r[k])]));
    if (TOKEN_KEYS.some(k => tokens[k] === null)) q.add('missing_token_fields');
    return {
      id: r.local_request_id, ts: num(r.ts_ms), started: num(r.started_ms), ended: num(r.ended_ms),
      model: r.model || '', tokens, fp: r.account_fp || '', tier: r.tier || '',
      g: { '5h': pct(r.u5h), '7d': pct(r.u7d) }, reset: { '5h': normReset(r.reset_5h), '7d': normReset(r.reset_7d) },
      quality: q,
    };
  });
  return { rows, flags };
}

export function parseLifecycle(text) {
  const starts = new Map(), ends = new Set();
  let parseError = false;
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'start') starts.set(e.local_request_id, e.at_ms);
      else if (e.type === 'end') ends.add(e.local_request_id);
      else throw Error();
    } catch { parseError = true; }
  }
  const pending = [...starts].filter(([id]) => !ends.has(id)).map(([id, at]) => ({ id, at }));
  return { pending, parseError };
}

export function readLedgerDir(dir) {
  const ledger = parseLedger(fs.readFileSync(path.join(dir, LEDGER_FILE), 'utf8'));
  const lf = path.join(dir, LIFECYCLE_FILE);
  const lifecycle = fs.existsSync(lf) ? parseLifecycle(fs.readFileSync(lf, 'utf8')) : null;
  return { ...ledger, lifecycle };
}

const emptyTokens = () => Object.fromEntries(TOKEN_KEYS.map(k => [k, 0]));
function addTokens(byModel, r) {
  const t = byModel[r.model || '(unknown)'] ||= emptyTokens();
  for (const k of TOKEN_KEYS) t[k] += r.tokens[k] ?? 0;
}
const minuteIso = ms => new Date(Math.floor(ms / 60000) * 60000).toISOString();
function uuidFrom(s) {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// 반환: { intervals, waiting } — waiting은 경계 요청이 아직 끝나지 않아 보류한 구간 수.
export function computeIntervals({ rows, flags: ledgerFlags = new Set(), lifecycle = null }, { now = Date.now(), minTicks = MIN_TICKS } = {}) {
  const out = [];
  let waiting = 0;
  const byAccount = new Map();
  for (const r of rows) {
    if (!r.fp) continue; // 계정을 모르는 요청은 어느 구간에도 귀속하지 않는다.
    if (!byAccount.has(r.fp)) byAccount.set(r.fp, []);
    byAccount.get(r.fp).push(r);
  }
  const pending = lifecycle ? lifecycle.pending : [];
  for (const [fp, accRows] of byAccount) {
    for (const gauge of ['5h', '7d']) {
      const observed = accRows.filter(r => r.g[gauge] !== null && r.ts !== null).sort((a, b) => a.ts - b.ts);
      // reset 창 나누기
      const windows = [];
      for (const r of observed) {
        const w = windows.at(-1);
        const rs = r.reset[gauge];
        if (!w || (rs !== null && w.reset !== null && Math.abs(rs - w.reset) > RESET_TOLERANCE_MS)) windows.push({ reset: rs, rows: [r] });
        else { w.rows.push(r); if (w.reset === null) w.reset = rs; }
      }
      for (const w of windows) {
        // 틱 찾기: 흔들림(역행)은 무시하고 최댓값 기준.
        // 이웃한 두 관측 사이에 게이지가 MAX_STEP을 넘게 뛰면, 그 사이에 기록되지 않은 사용(다른 경로·기록 중단)이
        // 있었다고 보고 체인을 끊는다(seg 증가). 반영 지연으로 인한 정상 점프는 실측 최대 +4%p(5h).
        const ticks = [];
        let max = w.rows[0].g[gauge], seg = 0;
        for (let i = 1; i < w.rows.length; i++) {
          const v = w.rows[i].g[gauge];
          if (v > max) {
            // 급점프이거나, 앞 관측과 GAP_MS 넘게 떨어졌는데 올랐으면(반영 지연은 1분 안팎) 기록 밖 사용으로 본다.
            if (v - max > MAX_STEP[gauge] || w.rows[i].ts - w.rows[i - 1].ts > GAP_MS) { seg++; ticks.push({ k: v, t: w.rows[i].ts, seg }); }
            else for (let k = max + 1; k <= v; k++) ticks.push({ k, t: w.rows[i].ts, seg });
            max = v;
          }
        }
        // 틱 체인을 최소 틱 수로 끊는다(같은 seg 안에서만)
        let a = 0;
        for (let b = 1; b < ticks.length; b++) {
          if (ticks[b].seg !== ticks[a].seg) { a = b; continue; }
          if (ticks[b].k - ticks[a].k < minTicks[gauge] || ticks[b].t === ticks[a].t) continue;
          const A = ticks[a], B = ticks[b];
          const q = new Set(ledgerFlags);
          if (!lifecycle) q.add('lifecycle_unavailable');
          else if (lifecycle.parseError) q.add('lifecycle_parse_error');
          const blocking = pending.filter(p => p.at <= B.t);
          if (blocking.some(p => now - p.at < PENDING_GRACE_MS)) { waiting++; break; }
          if (blocking.length) q.add('pending_or_interrupted_requests');
          const inside = accRows.filter(r => r.ended !== null && r.ended > A.t && r.ended <= B.t);
          const tokens = {}, startInflight = {}, endInflight = {};
          const tiers = new Map();
          let routed = false;
          for (const r of inside) {
            addTokens(tokens, r);
            r.quality.forEach(f => { if (f === 'routed_upstream') routed = true; else q.add(f); });
            if (r.tier) tiers.set(r.tier, (tiers.get(r.tier) || 0) + 1);
          }
          for (const r of accRows) {
            if (r.started !== null && r.ended !== null && r.started <= A.t && r.ended > A.t) addTokens(startInflight, r);
            if (r.started !== null && r.ended !== null && r.started <= B.t && r.ended > B.t) addTokens(endInflight, r);
          }
          if (tiers.size > 1) q.add('tier_changed');
          if (!inside.length) q.add('no_requests_in_interval');
          const tier = [...tiers].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
          if (!tier) q.add('tier_unknown');
          const reset = w.reset === null ? null : new Date(w.reset).toISOString();
          if (!reset) q.add('reset_unknown');
          out.push({
            interval_id: uuidFrom(['jinsil/interval/v1', fp, gauge, reset, A.k, B.k, A.t].join('|')),
            account_fp: fp, tier, gauge, reset_at: reset,
            g_start: A.k, g_end: B.k, t_start: minuteIso(A.t), t_end: minuteIso(B.t),
            tokens_by_model: tokens,
            boundary: { start_inflight_by_model: startInflight, end_inflight_by_model: endInflight },
            requests: inside.length, quality: [...q].sort(), routed_upstream: routed,
          });
          a = b;
        }
      }
    }
  }
  return { intervals: out, waiting };
}

// 로컬 표시용 잠정 비용(서버가 정본을 다시 계산한다).
export function localCost(tokensByModel) {
  let sum = 0;
  for (const [model, t] of Object.entries(tokensByModel)) {
    const c = costOf(model, t);
    if (c === null) return null;
    sum += c;
  }
  return sum;
}
export { PRICES };
