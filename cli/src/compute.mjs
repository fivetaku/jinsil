// 로컬 관측값과 잠정 단가의 부분합을 구분한다. 헤더 게이지만으로 한도 환산을 확정하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './paths.mjs';
import { PRICES } from './prices.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1]]]) : a, []));
if (args.teamclaude) throw Error('Do not merge legacy teamclaude rows: overlapping requests cannot be deduplicated reliably');
const file = (args.ledger || path.join(dataDir(), 'usage.tsv')).replace(/^~/, os.homedir());
const COMP = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];
const TOKENS = [...COMP, 'cache_write_unknown'];
const number = s => s !== '' && s !== undefined && Number.isFinite(Number(s)) ? Number(s) : null;
const token = s => { const n = number(s); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
const gauge = s => { const n = number(s); return n !== null && n >= 0 && n <= 1 ? n : null; };
function reset(s) {
  if (!s) return null;
  const n = number(s);
  const ms = n === null ? Date.parse(s) : n < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
const text = fs.readFileSync(file, 'utf8');
const [head, ...lines] = text.replace(/\n+$/, '').split('\n'); // trimEnd는 끝 빈 열(탭)까지 지운다
const cols = head.split('\t');
if (!['ts_ms', 'model', 'input', 'output'].every(k => cols.includes(k))) throw Error('Invalid ledger header');
const globalFlags = new Set();
if (!text.endsWith('\n')) globalFlags.add('truncated_ledger_tail');
const localIds = new Set(), upstreamIds = new Set();
const rows = lines.filter(Boolean).map(line => {
  const values = line.split('\t');
  const r = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
  const flags = new Set((r.quality || '').split(',').filter(f => f && f !== 'complete'));
  if (values.length !== cols.length) flags.add('malformed_row');
  if (r.schema_version !== '3') flags.add('legacy_unverified');
  if (r.complete !== '1' || r.usage_observed !== '1') flags.add('incomplete_usage');
  if (+r.http_status !== 200) flags.add('http_error');
  for (const k of TOKENS) r[k] = token(r[k]);
  if (TOKENS.some(k => r[k] === null)) flags.add('missing_token_fields');
  if (r.cache_write_unknown > 0) flags.add('cache_ttl_unknown');
  if (!Object.hasOwn(PRICES, r.model)) flags.add('unpriced_model');
  if (!r.local_request_id) flags.add('missing_local_id');
  else if (localIds.has(r.local_request_id)) { flags.add('duplicate_local_id'); globalFlags.add('duplicate_local_id'); }
  else localIds.add(r.local_request_id);
  if (r.request_id && upstreamIds.has(r.request_id)) { flags.add('duplicate_upstream_id'); globalFlags.add('duplicate_upstream_id'); }
  if (r.request_id) upstreamIds.add(r.request_id);
  r.ts = number(r.ts_ms);
  if (r.ts === null || !Number.isFinite(new Date(r.ts).getTime())) { r.ts = 0; flags.add('invalid_timestamp'); }
  r.u5h = gauge(r.u5h); r.u7d = gauge(r.u7d);
  r.reset_5h = reset(r.reset_5h); r.reset_7d = reset(r.reset_7d);
  r.flags = flags;
  return r;
}).sort((a, b) => a.ts - b.ts);
const lifecycle = path.join(path.dirname(file), 'lifecycle.jsonl');
let unmatched = null;
if (fs.existsSync(lifecycle)) {
  const starts = new Set(), ends = new Set();
  for (const line of fs.readFileSync(lifecycle, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (!e.local_request_id || !['start', 'end'].includes(e.type)) throw Error();
      (e.type === 'start' ? starts : ends).add(e.local_request_id);
    } catch { globalFlags.add('lifecycle_parse_error'); }
  }
  unmatched = [...starts].filter(id => !ends.has(id) || !localIds.has(id)).length;
  if (unmatched) globalFlags.add('pending_or_interrupted_requests');
  if ([...localIds].some(id => !starts.has(id) || !ends.has(id))) globalFlags.add('lifecycle_mismatch');
} else globalFlags.add('lifecycle_unavailable');
const round = n => +n.toFixed(8);
function summarize(group) {
  const flags = new Set(globalFlags), byModel = Object.create(null);
  const byComponent = Object.fromEntries(COMP.map(k => [k, 0]));
  const unpriced = new Set();
  for (const r of group) {
    r.flags.forEach(f => flags.add(f));
    const p = Object.hasOwn(PRICES, r.model) ? PRICES[r.model] : null;
    if (!p) unpriced.add(r.model || '(unknown)');
    const t = byModel[r.model || '(unknown)'] ||= Object.fromEntries(TOKENS.map(k => [k, 0]));
    TOKENS.forEach(k => { if (r[k] !== null) t[k] += r[k]; });
    COMP.forEach((k, i) => { if (p && r[k] !== null) byComponent[k] += r[k] * p[i] / 1e6; });
  }
  const known = round(Object.values(byComponent).reduce((a, b) => a + b, 0));
  return { requests: group.length, tokens_by_model: byModel,
    cost_usd_by_component: Object.fromEntries(Object.entries(byComponent).map(([k, v]) => [k, round(v)])),
    known_cost_usd: known, cost_usd: flags.size ? null : known,
    unpriced_models: [...unpriced], quality: [...flags].sort() };
}
function windows(key, resetKey) {
  const groups = []; let w;
  for (const r of rows) {
    if (r[key] === null) continue; // Retained in totals; not assigned to an invented gauge window.
    const changed = w && r[resetKey] !== null && w.reset !== null && Math.abs(r[resetKey] - w.reset) > 2000;
    const decreased = w && r[key] < w.last;
    if (!w || changed || decreased) {
      if (decreased && !changed) { w.flags.add('gauge_decrease_without_reset'); }
      w = { rows: [], reset: r[resetKey], last: r[key], flags: new Set() };
      if (decreased && !changed) w.flags.add('gauge_decrease_without_reset');
      groups.push(w);
    }
    if (r[resetKey] === null) w.flags.add('reset_unknown');
    w.rows.push(r); w.last = r[key];
  }
  return groups.map(w => {
    const first = w.rows[0], last = w.rows.at(-1), summary = summarize(w.rows);
    const reasons = new Set([...summary.quality, ...w.flags, 'header_boundary_unverified', 'provisional_prices']);
    if (rows.some(r => r[key] === null)) reasons.add('unassigned_gauge_rows');
    const span = round(last[key] - first[key]);
    if (span <= 0) reasons.add('no_gauge_increase');
    return { gauge: key === 'u5h' ? '5h' : '7d', start: new Date(first.ts).toISOString(), end: new Date(last.ts).toISOString(),
      reset_at: w.reset === null ? null : new Date(w.reset).toISOString(),
      start_pct: round(first[key] * 100), end_pct: round(last[key] * 100), span_pct: round(span * 100),
      ...summary, usd_per_100pct: null, extrapolation_status: 'withheld', extrapolation_blockers: [...reasons].sort() };
  });
}
console.log(JSON.stringify({ schema: 'jinsil/requests/v3', calculator_version: '3.0.0',
  price_version: 'attachment-2026-09-23-provisional', price_status: 'not_independently_verified',
  tier: args.tier || null, tier_verification: 'user_supplied', generated_at: new Date().toISOString(),
  unmatched_requests: unmatched, totals: summarize(rows), windows: [...windows('u5h', 'reset_5h'), ...windows('u7d', 'reset_7d')],
  submission_ready: false }, null, 2));
