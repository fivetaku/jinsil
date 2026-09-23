// 구간 제출 수집·검증·서버 비용 재계산 (PRD 02 자동 검증 규칙).
import { json, readJson } from './util.js';
import { deviceFromBearer } from './device.js';

export const MIN_TICKS = { '5h': 3, '7d': 1 };
const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'cache_write_unknown'];
const COMPONENTS = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];
const PER_MINUTE_LIMIT = 30;
const PER_DAY_ACCOUNT_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const isIso = s => typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));

function validTokens(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const models = Object.keys(obj);
  if (models.length > 20) return false;
  return models.every(m => /^[a-z0-9._()-]{1,64}$/.test(m) && TOKEN_KEYS.every(k => isInt(obj[m]?.[k])) && Object.keys(obj[m]).every(k => TOKEN_KEYS.includes(k)));
}

// 반환: null(정상) 또는 거부 사유
export function validate(p) {
  if (!p || typeof p !== 'object') return 'invalid_body';
  const allowed = new Set(['interval_id', 'account_fp', 'tier', 'gauge', 'reset_at', 'g_start', 'g_end', 't_start', 't_end',
    'tokens_by_model', 'boundary', 'requests', 'quality', 'routed_upstream', 'client']);
  const extra = Object.keys(p).find(k => !allowed.has(k));
  if (extra) return `unexpected_field_${extra.replace(/[^a-z_]/g, '').slice(0, 30)}`;
  if (!UUID_RE.test(p.interval_id || '')) return 'invalid_interval_id';
  if (!/^[0-9a-f]{64}$/.test(p.account_fp || '')) return 'invalid_account_fp';
  if (p.tier !== null && !(typeof p.tier === 'string' && /^[a-z0-9_]{1,64}$/.test(p.tier))) return 'invalid_tier';
  if (!['5h', '7d'].includes(p.gauge)) return 'invalid_gauge';
  if (p.reset_at !== null && !isIso(p.reset_at)) return 'invalid_reset_at';
  if (!isInt(p.g_start, 0, 150) || !isInt(p.g_end, 0, 150) || p.g_end <= p.g_start) return 'invalid_gauge_range';
  if (!isIso(p.t_start) || !isIso(p.t_end) || Date.parse(p.t_end) < Date.parse(p.t_start)) return 'invalid_time_range';
  if (Date.parse(p.t_end) > Date.now() + 10 * 60000) return 'time_in_future';
  if (!validTokens(p.tokens_by_model)) return 'invalid_tokens';
  if (!p.boundary || !validTokens(p.boundary.start_inflight_by_model) || !validTokens(p.boundary.end_inflight_by_model)
    || Object.keys(p.boundary).length !== 2) return 'invalid_boundary';
  if (!isInt(p.requests, 0, 1e7)) return 'invalid_requests';
  if (!Array.isArray(p.quality) || p.quality.length > 30 || !p.quality.every(q => typeof q === 'string' && /^[a-z_]{1,48}$/.test(q))) return 'invalid_quality';
  if (typeof p.routed_upstream !== 'boolean') return 'invalid_routed_upstream';
  if (!p.client || typeof p.client.version !== 'string' || p.client.version.length > 16) return 'invalid_client';
  return null;
}

export async function priceTable(env) {
  const { results } = await env.DB.prepare(`SELECT model, component, usd_per_mtok, valid_from, verified_at FROM prices ORDER BY valid_from DESC`).all();
  const table = {};
  let verified = true;
  for (const r of results) {
    table[r.model] ||= {};
    if (table[r.model][r.component] === undefined) { table[r.model][r.component] = r.usd_per_mtok; if (!r.verified_at) verified = false; }
  }
  return { table, version: verified ? 'verified' : 'attachment-2026-09-23-provisional' };
}
// 모르는 모델·TTL 미확인이면 null. 0으로 채우지 않는다.
export function costOf(tokensByModel, table) {
  let sum = 0;
  for (const [model, t] of Object.entries(tokensByModel)) {
    const p = table[model];
    if (!p || COMPONENTS.some(c => p[c] === undefined)) return { cost: null, reason: 'unpriced_model' };
    if (t.cache_write_unknown > 0) return { cost: null, reason: 'cache_ttl_unknown' };
    sum += COMPONENTS.reduce((s, c) => s + t[c] * p[c], 0) / 1e6;
  }
  return { cost: sum, reason: null };
}

const tag = fp => fp.slice(-4);

export async function submit(req, env) {
  const device = await deviceFromBearer(req, env);
  if (!device) return json({ status: 'rejected', reason: 'unauthorized' }, 401);
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM intervals WHERE device_id = ? AND created_at > ?').bind(device.id, now - 60000).first();
  if (recent.n >= PER_MINUTE_LIMIT) return json({ status: 'rejected', reason: 'rate_limited' }, 429);
  let p;
  try { p = await readJson(req, 64 * 1024); } catch (e) { return json({ status: 'rejected', reason: e.message }, e.status || 400); }
  const invalid = validate(p);
  if (invalid) return json({ status: 'rejected', reason: invalid }, 422);
  await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now, device.id).run();

  const existing = await env.DB.prepare('SELECT account_fp, status, exclude_reason FROM intervals WHERE interval_id = ?').bind(p.interval_id).first();
  if (existing) {
    if (existing.account_fp !== p.account_fp) return json({ status: 'rejected', reason: 'interval_id_conflict' }, 409);
    return json({ status: existing.status, reason: existing.exclude_reason, duplicate: true }, 200);
  }
  // 계정 결속: 처음 제출한 웹 사용자에게 묶인다.
  const acct = await env.DB.prepare('SELECT user_id, first_seen FROM claude_accounts WHERE account_fp = ?').bind(p.account_fp).first();
  if (acct && acct.user_id !== device.user_id) {
    await env.DB.prepare('INSERT INTO flags (account_fp, rule, detail, created_at) VALUES (?, ?, ?, ?)').bind(p.account_fp, 'account_bound_to_other_user', device.user_id, now).run();
    return json({ status: 'rejected', reason: 'account_bound_to_other_user' }, 409);
  }
  // 같은 계정·게이지·reset 창에서 게이지 범위가 겹치면 이중 제출
  const overlap = await env.DB.prepare(`SELECT interval_id FROM intervals WHERE account_fp = ? AND gauge = ? AND IFNULL(reset_at,'') = IFNULL(?, '')
    AND g_start < ? AND g_end > ? LIMIT 1`).bind(p.account_fp, p.gauge, p.reset_at, p.g_end, p.g_start).first();
  if (overlap) return json({ status: 'rejected', reason: 'overlapping_interval' }, 409);

  const { table, version } = await priceTable(env);
  const main = costOf(p.tokens_by_model, table);
  const startB = costOf(p.boundary.start_inflight_by_model, table);
  const endB = costOf(p.boundary.end_inflight_by_model, table);
  const span = p.g_end - p.g_start;
  let status = 'accepted', reason = null;
  if (p.quality.length) { status = 'excluded'; reason = p.quality[0]; }
  else if (p.routed_upstream) { status = 'excluded'; reason = 'routed_upstream'; }
  else if (main.cost === null) { status = 'excluded'; reason = main.reason; }
  else if (startB.cost === null || endB.cost === null) { status = 'excluded'; reason = startB.reason || endB.reason; }
  else if (span < MIN_TICKS[p.gauge]) { status = 'excluded'; reason = 'too_few_ticks'; }
  else if (!p.tier) { status = 'excluded'; reason = 'tier_unknown'; }
  else if (p.requests === 0) { status = 'excluded'; reason = 'no_requests'; }
  const day = await env.DB.prepare('SELECT COUNT(*) AS n FROM intervals WHERE account_fp = ? AND created_at > ?').bind(p.account_fp, now - 86400000).first();
  if (status === 'accepted' && day.n >= PER_DAY_ACCOUNT_LIMIT) { status = 'flagged'; reason = 'daily_interval_cap'; }

  const cost = main.cost;
  const stmts = [];
  if (!acct) stmts.push(env.DB.prepare('INSERT INTO claude_accounts (account_fp, user_id, tier_latest, public_tag, first_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(p.account_fp, device.user_id, p.tier, tag(p.account_fp), now));
  else if (p.tier) stmts.push(env.DB.prepare('UPDATE claude_accounts SET tier_latest = ? WHERE account_fp = ?').bind(p.tier, p.account_fp));
  stmts.push(env.DB.prepare(`INSERT INTO intervals (interval_id, account_fp, device_id, tier, gauge, reset_at, g_start, g_end, t_start, t_end,
    boundary_json, requests, quality_json, routed_upstream, client_version, price_version, cost_usd, cost_lo, cost_hi, usd_per_pct, status, exclude_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    p.interval_id, p.account_fp, device.id, p.tier, p.gauge, p.reset_at, p.g_start, p.g_end, p.t_start, p.t_end,
    JSON.stringify(p.boundary), p.requests, JSON.stringify(p.quality), p.routed_upstream ? 1 : 0, p.client.version, version,
    cost, cost === null || startB.cost === null ? null : cost - startB.cost, cost === null || endB.cost === null ? null : cost + endB.cost,
    cost === null ? null : cost / span, status, reason, now));
  for (const [model, t] of Object.entries(p.tokens_by_model)) stmts.push(env.DB.prepare(`INSERT INTO interval_tokens
    (interval_id, model, input, output, cache_read, cache_write_5m, cache_write_1h, cache_write_unknown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.interval_id, model, t.input, t.output, t.cache_read, t.cache_write_5m, t.cache_write_1h, t.cache_write_unknown));
  if (status === 'flagged') stmts.push(env.DB.prepare('INSERT INTO flags (interval_id, account_fp, rule, created_at) VALUES (?, ?, ?, ?)').bind(p.interval_id, p.account_fp, reason, now));
  await env.DB.batch(stmts);
  return json({ status, reason, cost_usd: cost, price_version: version }, 201);
}
