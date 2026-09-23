// 증거 묶음 v2 (01_PRD 3-6): 공개 요금제별 익명 창 목록 — 계정 태그, 게이지 샘플, bin 비용, 제외 사유, 단가 버전(해시)·계산 버전.
// - 시각은 창 기준점(t_base)에서의 상대 분으로만 싣는다(활동 시간대 비노출, 원장 #4). 절대 시각·지문·사용자 ID 없음.
// - 같은 DB 상태 → 같은 JSON·같은 sha256(생성 시각 등 가변 필드를 해시 대상에 넣지 않는다).
import { json } from './util.js';
import { accountStats, planStats, planPrices, exclusionCounts, PLANS } from './stats.js';
import { binCost, sha256hex } from './bins.js';
import { CALC_VERSION, BIN_MS } from '../../cli/src/window.mjs';

const r6 = v => (v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6);
const rel = (t, base) => Math.round((t - base) / 60000);

export async function build(env, plan) {
  if (!PLANS.includes(plan)) return null;
  const [prices, list, excl] = await Promise.all([planPrices(env), accountStats(env), exclusionCounts(env)]);
  const stats = planStats(list, env, prices, excl)[plan];
  if (!stats.shown) return null;
  const members = list.filter(a => a.plan === plan && a.eligible).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const tables = {}, accounts = [];
  for (const a of members) {
    const { results: ws } = await env.DB.prepare('SELECT * FROM windows WHERE account_fp = ? AND plan = ? ORDER BY gauge, t_base').bind(a.account_fp, plan).all();
    const windows = [];
    for (const w of ws) {
      if (w.price_version && !tables[w.price_version]) {
        const pv = await env.DB.prepare('SELECT source_url FROM price_versions WHERE hash = ?').bind(w.price_version).first();
        tables[w.price_version] = pv ? JSON.parse(pv.source_url) : null;
      }
      const table = Object.fromEntries((tables[w.price_version] || []).map(([m, cs]) => [m, Object.fromEntries(cs)]));
      const [{ results: samples }, { results: bins }] = await Promise.all([
        env.DB.prepare('SELECT observed_at, MAX(utilization) AS u FROM gauge_samples WHERE account_fp = ? AND gauge = ? AND observed_at BETWEEN ? AND ? GROUP BY observed_at ORDER BY observed_at')
          .bind(a.account_fp, w.gauge, w.t_base, w.t_end).all(),
        env.DB.prepare('SELECT * FROM usage_bins WHERE account_fp = ? AND bin_start >= ? AND bin_start <= ? ORDER BY bin_start, model, device_id')
          .bind(a.account_fp, w.t_base - BIN_MS, w.t_end).all(),
      ]);
      const perBin = new Map();
      for (const b of bins) {
        const c = binCost(b, table), k = rel(b.bin_start, w.t_base);
        const cur = perBin.get(k) ?? 0;
        perBin.set(k, cur === null || c === null ? null : cur + c);
      }
      windows.push({ gauge: w.gauge, state: w.state, stage: w.stage, exclude_reason: w.exclude_reason, g_base: w.g_base, g_end: w.g_end, delta: w.delta,
        duration_min: rel(w.t_end, w.t_base), cost: r6(w.cost), cost_lo: r6(w.cost_lo), cost_hi: r6(w.cost_hi), usd_per_pct: r6(w.usd_per_pct),
        price_version: w.price_version, calc_version: w.calc_version,
        samples: samples.map(s => [rel(s.observed_at, w.t_base), s.u]), bins: [...perBin].map(([k, c]) => [k, r6(c)]) });
    }
    accounts.push({ tag: a.tag, stage: a.stage, usd_per_100pct: r6(a.usd_per_100pct), range_lo: r6(a.range_lo), range_hi: r6(a.range_hi), windows });
  }
  const body = { format: 'jinsil-evidence/1', plan, calc_version: CALC_VERSION,
    summary: { n: stats.n, median_usd_per_100pct: r6(stats.median_usd_per_100pct), range_lo: r6(stats.range_lo), range_hi: r6(stats.range_hi), stages: stats.stages },
    formula: 'account = ΣC/ΣΔ×100, range = ΣC⁻/Σ(Δ+1)×100 ~ ΣC⁺/Σ(Δ−1)×100, plan = median(account)',
    note: '참여자가 로컬에서 관측해 제출한 값 · 시각은 창 기준점 대비 분',
    price_tables: tables, accounts };
  const text = JSON.stringify(body);
  return { text, sha256: await sha256hex(text) };
}

export async function handle(env, plan) {
  const r = await build(env, plan);
  if (!r) return json({ error: 'not_public', message: '공개 기준을 채운 요금제만 증거 묶음을 제공합니다' }, 404);
  return new Response(r.text, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-evidence-sha256': r.sha256,
    'content-disposition': `attachment; filename="jinsil-evidence-${plan}-${r.sha256.slice(0, 12)}.json"`, 'cache-control': 'public, max-age=60' } });
}
