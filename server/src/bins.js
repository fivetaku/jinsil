// v2 수신: POST /v2/bins — 계정별 5분 bin(토큰 합)과 게이지 샘플. 받은 뒤 그 계정의 한도 창을 다시 계산한다.
// - 창 계산은 CLI와 같은 코드(cli/src/window.mjs)를 쓴다.
// - bin은 (계정, 기기, bin_start, 모델) 단위 upsert. 메시지 수가 줄어드는 갱신(오래된 revision)은 받지 않는다.
// - 계정 결속: 처음 제출한 웹 사용자에게 묶인다(다른 사용자면 409).
// - 서버는 제출값의 진위를 검증하지 못한다 — 공개 표기는 "참여자 로컬 관측값".
import { json, readJson } from './util.js';
import { deviceFromBearer } from './device.js';
import { priceTable } from './intervals.js';
import { computeWindows, BIN_MS } from '../../cli/src/window.mjs';
import { planOf } from '../../cli/src/tiers.mjs';

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'cache_write_unknown'];
const COMPONENTS = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];
const SPECIAL_KEYS = ['nonstandard_speed', 'web_search_requests', 'web_fetch_requests'];
const MAX_BINS = 200, MAX_SAMPLES = 400;
export const PER_MINUTE_REQUESTS = 20;
const HISTORY_MS = 9 * 86400000;
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const isIso = s => typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));
const onlyKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));

export function validate(p, now = Date.now()) {
  if (!onlyKeys(p, ['account_fp', 'tier', 'bins', 'samples', 'client'])) return 'unknown_field';
  if (typeof p.account_fp !== 'string' || !/^[0-9a-f]{64}$/.test(p.account_fp)) return 'invalid_account_fp';
  if (p.tier !== null && (typeof p.tier !== 'string' || !/^[a-z0-9_]{1,64}$/.test(p.tier))) return 'invalid_tier';
  if (!Array.isArray(p.bins) || p.bins.length > MAX_BINS) return 'invalid_bins';
  if (!Array.isArray(p.samples) || p.samples.length > MAX_SAMPLES) return 'invalid_samples';
  if (!p.bins.length && !p.samples.length) return 'empty';
  if (!onlyKeys(p.client, ['version', 'collector']) || typeof p.client.version !== 'string' || p.client.version.length > 16 || !['transcript', 'proxy', 'teamclaude'].includes(p.client.collector)) return 'invalid_client';
  const lo = now - 40 * 86400000, hi = now + 10 * 60000;
  for (const b of p.bins) {
    if (!onlyKeys(b, ['bin_start', 'model', ...TOKEN_KEYS, 'messages', 'sidechain_messages', 'special', 'revision'])) return 'unknown_bin_field';
    if (!isInt(b.bin_start, lo, hi) || b.bin_start % BIN_MS) return 'invalid_bin_start';
    if (typeof b.model !== 'string' || !/^claude-[a-z0-9.-]{1,60}$/.test(b.model)) return 'invalid_model';
    if (!TOKEN_KEYS.every(k => isInt(b[k], 0, 1e12)) || !isInt(b.messages, 1, 1e6) || !isInt(b.sidechain_messages ?? 0, 0, b.messages)) return 'invalid_tokens';
    if (!onlyKeys(b.special ?? {}, SPECIAL_KEYS) || !Object.values(b.special ?? {}).every(v => isInt(v, 0, 1e6))) return 'invalid_special';
    if (typeof b.revision !== 'string' || !/^[0-9a-f]{16}$/.test(b.revision)) return 'invalid_revision';
  }
  for (const s of p.samples) {
    if (!onlyKeys(s, ['observed_at', 'gauge', 'utilization', 'resets_at', 'source', 'tier'])) return 'unknown_sample_field';
    if (!isInt(s.observed_at, lo, hi) || !['5h', '7d'].includes(s.gauge) || typeof s.utilization !== 'number' || !(s.utilization >= 0 && s.utilization <= 100)) return 'invalid_sample';
    if (!isIso(s.resets_at) || !['usage_api', 'header'].includes(s.source)) return 'invalid_sample';
    if (s.tier !== null && s.tier !== undefined && (typeof s.tier !== 'string' || !/^[a-z0-9_]{1,64}$/.test(s.tier))) return 'invalid_tier';
  }
  return null;
}

// 요청 기준 레이트 제한: key(기기·엔드포인트)별 분당 요청 수.
export async function rateLimited(env, key, limit, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  const row = await env.DB.prepare(`INSERT INTO request_counts (key, minute, n) VALUES (?, ?, 1)
    ON CONFLICT(key, minute) DO UPDATE SET n = n + 1 RETURNING n`).bind(key, minute).first();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM request_counts WHERE minute < ?').bind(minute - 60).run();
  return row.n > limit;
}

export const binCost = (b, table) => {
  const p = table[b.model];
  if (!p || COMPONENTS.some(c => p[c] === undefined) || b.cache_write_unknown > 0) return null;
  return COMPONENTS.reduce((s, c) => s + b[c] * p[c], 0) / 1e6;
};

// 계정의 창 다시 계산(최근 9일). 여러 기기 bin은 합산하고, 샘플은 어느 기기 것이든 쓴다.
export async function recomputeAccount(env, account_fp, now = Date.now()) {
  const since = now - HISTORY_MS;
  const [{ results: samples }, { results: bins }] = await Promise.all([
    env.DB.prepare('SELECT gauge, observed_at, utilization, resets_at, tier, device_id, source FROM gauge_samples WHERE account_fp = ? AND observed_at > ? ORDER BY observed_at').bind(account_fp, since).all(),
    env.DB.prepare('SELECT * FROM usage_bins WHERE account_fp = ? AND bin_start > ?').bind(account_fp, since).all(),
  ]);
  const { table, version: priceStatus } = await priceTable(env);
  // 재계산 근거: 실제 쓴 단가표 내용의 해시를 가격 버전으로 남긴다.
  const canon = JSON.stringify(Object.keys(table).sort().map(m => [m, Object.keys(table[m]).sort().map(c => [c, table[m][c]])]));
  const version = `${priceStatus === 'verified' ? 'v' : 'p'}-${(await sha256hex(canon)).slice(0, 16)}`;
  await env.DB.prepare('INSERT OR IGNORE INTO price_versions (hash, created_at, source_url) VALUES (?, ?, ?)').bind(version, now, canon).run();
  // 같은 시각 bin을 기기 간 합산. 같은 (bin_start, 모델)을 서로 다른 기기가 똑같은 내용으로 냈다면 중복 수집(동기화 폴더 등) 의심 → 창 제외.
  const byKey = new Map(), dup = new Set();
  for (const b of bins) {
    const k = `${b.bin_start}|${b.model}`;
    for (const o of byKey.get(k) || []) if (o.device_id !== b.device_id && TOKEN_KEYS.every(x => o[x] === b[x]) && o.messages === b.messages) dup.add(b.bin_start);
    (byKey.get(k) || byKey.set(k, []).get(k)).push(b);
  }
  const perBin = new Map();
  for (const b of bins) {
    const cost = binCost(b, table);
    const special = JSON.parse(b.special_json || '{}');
    const cur = perBin.get(b.bin_start) || { bin_start: b.bin_start, cost: 0, unpriced: false };
    cur.cost = cur.cost === null || cost === null ? null : cur.cost + cost;
    if (Object.keys(special).length) cur.unpriced = true;
    perBin.set(b.bin_start, cur);
  }
  const ws = computeWindows({ samples, bins: [...perBin.values()], now });
  const devices = new Set(bins.map(b => b.device_id)).size || 1;
  const collectors = [...new Set(bins.map(b => b.collector))].sort().join(',');
  const stmts = [];
  for (const w of ws) {
    let exclude = w.exclude_reason;
    if (!exclude && [...dup].some(t => t + BIN_MS > w.t_base && t < w.t_end + BIN_MS)) exclude = 'duplicate_collection_suspected';
    const id = await windowId(account_fp, w.gauge, w.resets_at);
    stmts.push(env.DB.prepare(`INSERT INTO windows (window_id, account_fp, gauge, resets_at, tier, plan, g_base, t_base, g_end, t_end, samples, delta,
      cost, cost_lo, cost_hi, usd_per_pct, usd_per_pct_lo, usd_per_pct_hi, stage, state, exclude_reason, collectors, devices, price_version, calc_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(window_id) DO UPDATE SET tier=excluded.tier, plan=excluded.plan, g_base=excluded.g_base, t_base=excluded.t_base, g_end=excluded.g_end,
        t_end=excluded.t_end, samples=excluded.samples, delta=excluded.delta, cost=excluded.cost, cost_lo=excluded.cost_lo, cost_hi=excluded.cost_hi,
        usd_per_pct=excluded.usd_per_pct, usd_per_pct_lo=excluded.usd_per_pct_lo, usd_per_pct_hi=excluded.usd_per_pct_hi, stage=excluded.stage,
        state=excluded.state, exclude_reason=excluded.exclude_reason, collectors=excluded.collectors, devices=excluded.devices,
        price_version=excluded.price_version, calc_version=excluded.calc_version, updated_at=excluded.updated_at`).bind(
      id, account_fp, w.gauge, w.resets_at, w.tier, planOf(w.tier), w.g_base, w.t_base, w.g_end, w.t_end, w.samples, w.delta,
      w.cost, w.cost_lo, w.cost_hi, w.usd_per_pct, w.usd_per_pct_lo, w.usd_per_pct_hi, w.stage, w.state, exclude, collectors, devices, version, w.calc_version, now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return ws.length;
}

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const windowId = async (fp, gauge, resetsAt) => (await sha256hex(`${fp}|${gauge}|${resetsAt}`)).slice(0, 32);

export async function submit(req, env) {
  const device = await deviceFromBearer(req, env);
  if (!device) return json({ status: 'rejected', reason: 'unauthorized' }, 401);
  const now = Date.now();
  if (await rateLimited(env, `bins:${device.id}`, PER_MINUTE_REQUESTS, now)) return json({ status: 'rejected', reason: 'rate_limited' }, 429);
  let p;
  try { p = await readJson(req, 256 * 1024); } catch (e) { return json({ status: 'rejected', reason: e.message }, e.status || 400); }
  const invalid = validate(p, now);
  if (invalid) return json({ status: 'rejected', reason: invalid }, 422);
  const acct = await env.DB.prepare('SELECT user_id FROM claude_accounts WHERE account_fp = ?').bind(p.account_fp).first();
  if (acct && acct.user_id !== device.user_id) {
    await env.DB.prepare('INSERT INTO flags (account_fp, rule, detail, created_at) VALUES (?, ?, ?, ?)').bind(p.account_fp, 'account_bound_to_other_user', device.user_id, now).run();
    return json({ status: 'rejected', reason: 'account_bound_to_other_user' }, 409);
  }
  const stmts = [env.DB.prepare('UPDATE devices SET last_seen = ?, collector = ?, client_version = ? WHERE id = ?').bind(now, p.client.collector, p.client.version, device.id)];
  if (!acct) stmts.push(env.DB.prepare('INSERT INTO claude_accounts (account_fp, user_id, tier_latest, public_tag, first_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(p.account_fp, device.user_id, p.tier, p.account_fp.slice(-4), now));
  else if (p.tier) stmts.push(env.DB.prepare('UPDATE claude_accounts SET tier_latest = ? WHERE account_fp = ?').bind(p.tier, p.account_fp));
  for (const b of p.bins) stmts.push(env.DB.prepare(`INSERT INTO usage_bins (account_fp, device_id, bin_start, model, input, output, cache_read, cache_write_5m,
      cache_write_1h, cache_write_unknown, messages, sidechain_messages, special_json, revision, collector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_fp, device_id, bin_start, model) DO UPDATE SET input=excluded.input, output=excluded.output, cache_read=excluded.cache_read,
      cache_write_5m=excluded.cache_write_5m, cache_write_1h=excluded.cache_write_1h, cache_write_unknown=excluded.cache_write_unknown, messages=excluded.messages,
      sidechain_messages=excluded.sidechain_messages, special_json=excluded.special_json, revision=excluded.revision, collector=excluded.collector, updated_at=excluded.updated_at
    WHERE excluded.messages >= usage_bins.messages AND excluded.revision <> usage_bins.revision`).bind(
    p.account_fp, device.id, b.bin_start, b.model, ...TOKEN_KEYS.map(k => b[k]), b.messages, b.sidechain_messages ?? 0, JSON.stringify(b.special ?? {}), b.revision, p.client.collector, now));
  for (const s of p.samples) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO gauge_samples (account_fp, gauge, observed_at, device_id, utilization, resets_at, source, tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.account_fp, s.gauge, s.observed_at, device.id, s.utilization, s.resets_at, s.source, s.tier ?? p.tier));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  const windows = await recomputeAccount(env, p.account_fp, now);
  return json({ status: 'accepted', bins: p.bins.length, samples: p.samples.length, windows }, 201);
}
