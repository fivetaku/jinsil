// 집계 v2(한도 창 기반, 01_PRD 3-4): 계정별 창 합산 → 요금제별 중앙값·범위·단계·제외 사유. 계정당 한 표.
// - 계정 값 = 현재 요금제의 제외 없는 창들의 ΣC/ΣΔ × 100(주간 100% 환산). 범위 = ΣC⁻/Σ(Δ+1) ~ ΣC⁺/Σ(Δ−1).
// - 단계(ΣΔ 기준): 5%p 잠정(등록) → 8%p 보통 → 11%p 정밀. 창이 커지면 자동 승급.
// - 공개: 적격 계정이 요금제별 MIN_ACCOUNTS 이상일 때만. 미달이면 수치를 서버에서 비운다(5시간 지표는 별도 표본 수).
// - 표기: 참여자가 로컬에서 관측해 제출한 값(서버는 진위를 검증하지 못함).
import { WEEKS_PER_MONTH } from './util.js';
import { planOf, PLAN_LABEL } from '../../cli/src/tiers.mjs';
import { STAGES } from '../../cli/src/window.mjs';

export const PLANS = ['pro', 'max5x', 'max20x', 'team_standard', 'team_premium'];
const ADVERT_GAP = 0.8;
const NON_PENALTY_RULES = ['account_bound_to_other_user'];
const stageOf = D => (STAGES.find(([min]) => D >= min) || [0, null])[1];

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = arr => quantile([...arr].sort((a, b) => a - b), 0.5);

export async function planPrices(env) {
  const { results } = await env.DB.prepare('SELECT plan, monthly_usd FROM plan_prices ORDER BY valid_from DESC').all();
  const out = {};
  for (const r of results) if (out[r.plan] === undefined) out[r.plan] = r.monthly_usd;
  return out;
}

export async function accountStats(env, now = Date.now()) {
  const probationMs = Number(env.PROBATION_HOURS ?? 24) * 3600000;
  const prices = await planPrices(env);
  const [{ results: accounts }, { results: sums }, { results: flagged }] = await Promise.all([
    env.DB.prepare('SELECT account_fp, user_id, tier_latest, public_tag, first_seen FROM claude_accounts').all(),
    env.DB.prepare(`SELECT account_fp, gauge, plan, COUNT(*) AS n, SUM(delta) AS d, SUM(cost) AS c, SUM(cost_lo) AS clo, SUM(cost_hi) AS chi,
      SUM(CASE WHEN state = 'final' THEN 1 ELSE 0 END) AS finals FROM windows
      WHERE exclude_reason IS NULL AND stage IS NOT NULL AND cost IS NOT NULL GROUP BY account_fp, gauge, plan`).all(),
    env.DB.prepare(`SELECT DISTINCT account_fp FROM flags WHERE account_fp IS NOT NULL AND (decision IS NULL OR decision <> 'dismissed')
      AND rule NOT IN (${NON_PENALTY_RULES.map(() => '?').join(',')})`).bind(...NON_PENALTY_RULES).all(),
  ]);
  const flaggedSet = new Set(flagged.map(r => r.account_fp));
  const by = new Map(accounts.map(a => [a.account_fp, { ...a, plan: planOf(a.tier_latest), g: {} }]));
  for (const s of sums) {
    const a = by.get(s.account_fp);
    // 현재 요금제의 창만(요금제를 바꾼 계정의 과거 사용량이 섞이지 않게)
    if (!a || !a.plan || s.plan !== a.plan) continue;
    a.g[s.gauge] = s;
  }
  const val = s => {
    if (!s || !(s.d > 0)) return null;
    const hiDen = s.d - s.n; // Σ(Δ−1)
    return { pct: s.d, windows: s.n, finals: s.finals, usd_per_100pct: s.c / s.d * 100,
      lo: s.clo !== null ? s.clo / (s.d + s.n) * 100 : null, hi: s.chi !== null && hiDen > 0 ? s.chi / hiDen * 100 : null, stage: stageOf(s.d) };
  };
  const list = [...by.values()].map(a => {
    const w = val(a.g['7d']), f = val(a.g['5h']);
    const price = a.plan ? prices[a.plan] : undefined;
    const w100 = w ? w.usd_per_100pct : null;
    const monthly = w100 === null ? null : w100 * WEEKS_PER_MONTH;
    let ineligible = null;
    if (!a.plan || !price) ineligible = 'plan_unknown';
    else if (!w || !w.stage) ineligible = 'insufficient_weekly_data';
    else if (flaggedSet.has(a.account_fp)) ineligible = 'flagged';
    else if (now - a.first_seen < probationMs) ineligible = 'probation';
    return { account_fp: a.account_fp, user_id: a.user_id, tag: a.public_tag, plan: a.plan, tier: a.tier_latest, price: price ?? null,
      weekly_pct: w?.pct ?? 0, windows: w?.windows ?? 0, stage: w?.stage ?? null, min_weekly_pct: STAGES.at(-1)[0],
      usd_per_100pct: w100, range_lo: w?.lo ?? null, range_hi: w?.hi ?? null,
      five_hour_usd_per_100pct: f?.stage ? f.usd_per_100pct : null, five_hour_pct: f?.pct ?? 0,
      monthly_value: monthly, value_multiple: monthly !== null && price ? monthly / price : null,
      effective_usd_per_api_usd: monthly ? price / monthly : null, probation: now - a.first_seen < probationMs,
      eligible: !ineligible, ineligible };
  });
  // 요금제별 이상치(IQR 3배) 제외(측정 오류 방어) 후 순위
  for (const plan of PLANS) {
    const el = list.filter(a => a.plan === plan && a.eligible);
    if (el.length >= 4) {
      const v = el.map(a => a.usd_per_100pct).sort((x, y) => x - y);
      const q1 = quantile(v, 0.25), q3 = quantile(v, 0.75), iqr = q3 - q1;
      for (const a of el) if (a.usd_per_100pct < q1 - 3 * iqr || a.usd_per_100pct > q3 + 3 * iqr) { a.eligible = false; a.ineligible = 'outlier'; }
    }
    const ranked = list.filter(a => a.plan === plan && a.eligible).sort((x, y) => y.value_multiple - x.value_multiple);
    ranked.forEach((a, i) => { a.rank = i + 1; a.n_in_plan = ranked.length; a.top_pct = Math.ceil((i + 1) / ranked.length * 100); });
  }
  return list;
}

export async function exclusionCounts(env) {
  const { results } = await env.DB.prepare(`SELECT plan, gauge, exclude_reason AS r, COUNT(*) AS n FROM windows WHERE exclude_reason IS NOT NULL GROUP BY plan, gauge, exclude_reason`).all();
  const out = {};
  for (const x of results) if (x.plan) ((out[x.plan] ||= {})[x.gauge] ||= {})[x.r] = x.n;
  return out;
}

export function planStats(list, env, prices, exclusions = {}) {
  const min = Number(env.MIN_ACCOUNTS ?? 5);
  const out = {};
  for (const plan of PLANS) {
    const el = list.filter(a => a.plan === plan && a.eligible);
    const v = el.map(a => a.usd_per_100pct).sort((x, y) => x - y);
    const five = el.map(a => a.five_hour_usd_per_100pct).filter(x => x !== null);
    const shown = el.length >= min, shown5 = five.length >= min;
    const med = shown ? quantile(v, 0.5) : null;
    const monthly = med === null ? null : med * WEEKS_PER_MONTH;
    const stages = { provisional: 0, normal: 0, precise: 0 };
    for (const a of el) stages[a.stage]++;
    // 공개 기준 미달이면 수치를 서버에서 비운다(UI 숨김만으로는 API로 샌다).
    out[plan] = { plan, label: PLAN_LABEL[plan], price: prices[plan] ?? null, n: el.length, n_5h: five.length, min_accounts: min,
      participants: list.filter(a => a.plan === plan).length, users: new Set(el.map(a => a.user_id)).size, shown, shown_5h: shown5,
      stages: shown ? stages : null,
      median_usd_per_100pct: med, p25: shown ? quantile(v, 0.25) : null, p75: shown ? quantile(v, 0.75) : null,
      range_lo: shown ? median(el.map(a => a.range_lo).filter(x => x !== null)) : null,
      range_hi: shown ? median(el.map(a => a.range_hi).filter(x => x !== null)) : null,
      five_hour_median_usd_per_100pct: shown5 ? median(five) : null,
      monthly_value: monthly, value_multiple: monthly !== null && prices[plan] ? monthly / prices[plan] : null,
      exclusions: exclusions[plan] || {} };
  }
  return out;
}

// 스티커 (PRD 01 '메인 화면: 가성비 스티커'). 기준 요금제: Pro가 공개 기준 충족 전엔 Max 5x.
export function stickers(plans) {
  const shown = Object.values(plans).filter(p => p.shown && p.value_multiple !== null);
  const base = plans.pro.shown ? plans.pro : plans.max5x.shown ? plans.max5x : null;
  const best = shown.length >= 2 ? shown.reduce((a, b) => (b.value_multiple > a.value_multiple ? b : a)) : null;
  const out = {};
  for (const p of Object.values(plans)) {
    const s = [];
    if (!p.shown) { s.push({ kind: 'waiting', text: `측정 대기 · 통계 반영 ${p.n}/${p.min_accounts}` }); out[p.plan] = s; continue; }
    if (best && best.plan === p.plan) s.push({ kind: 'best', text: '가성비 1위' });
    s.push({ kind: 'multiple', text: `구독료의 ${Math.round(p.value_multiple)}배` });
    if (base && base.plan === p.plan) s.push({ kind: 'baseline', text: '비교 기준' });
    else if (base) {
      const priceRatio = p.price / base.price, valueRatio = p.monthly_value / base.monthly_value;
      s.push({ kind: 'ratio', text: `가격 ${+priceRatio.toFixed(1)}배 → 가치 ${+valueRatio.toFixed(1)}배` });
      if (valueRatio < priceRatio * ADVERT_GAP) s.push({ kind: 'less', text: '광고보다 적음' });
    }
    out[p.plan] = s;
  }
  return { baseline: base?.plan ?? null, stickers: out };
}

export async function publicStats(env) {
  const [prices, list, excl] = await Promise.all([planPrices(env), accountStats(env), exclusionCounts(env)]);
  const plans = planStats(list, env, prices, excl);
  const ranking = {};
  for (const plan of PLANS) ranking[plan] = !plans[plan].shown ? [] : list.filter(a => a.plan === plan && a.eligible).sort((a, b) => a.rank - b.rank)
    .map(a => ({ rank: a.rank, tag: a.tag, value_multiple: a.value_multiple, usd_per_100pct: a.usd_per_100pct, range_lo: a.range_lo, range_hi: a.range_hi, weekly_pct: a.weekly_pct, stage: a.stage }));
  const { baseline, stickers: st } = stickers(plans);
  const priceVer = await env.DB.prepare('SELECT COUNT(*) AS n FROM prices WHERE verified_at IS NULL').first();
  const measuring = await env.DB.prepare('SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS devices FROM devices WHERE revoked_at IS NULL').first();
  return { plans, ranking, stickers: st, baseline, measuring: { users: measuring.users, devices: measuring.devices }, price_status: priceVer.n ? 'provisional' : 'verified',
    note: '참여자가 로컬에서 관측해 제출한 값 · 매주 100%를 다 썼을 때의 이론적 상한 · API 정가 환산' };
}

const STAGE_KO = { provisional: '잠정', normal: '보통', precise: '정밀' };
export const EXCLUDE_KO = { external_usage_suspected: '외부 사용 의심', tier_changed: '요금제 변경', unpriced_tokens: '비표준·미가격 토큰', below_min_delta: '게이지 상승 5%p 미만',
  duplicate_collection_suspected: '중복 수집 의심', attribution_unverified: '계정 미확정' };

export async function feed(env, limit = 30) {
  const [prices, list] = await Promise.all([planPrices(env), accountStats(env)]);
  const plans = planStats(list, env, prices);
  const { results } = await env.DB.prepare(`SELECT w.updated_at, w.gauge, w.g_base, w.g_end, w.stage, w.state, w.exclude_reason, w.plan, a.public_tag
    FROM windows w JOIN claude_accounts a ON a.account_fp = w.account_fp ORDER BY w.updated_at DESC LIMIT ?`).bind(limit * 3).all();
  // 공개 기준 미달 요금제의 제출 내역은 공개 피드에 싣지 않는다.
  return results.filter(r => plans[r.plan]?.shown).slice(0, limit).map(r => ({
    at: new Date(Math.floor(r.updated_at / 60000) * 60000).toISOString(), tag: r.public_tag, plan: r.plan, gauge: r.gauge,
    range: `${r.g_base}%→${r.g_end}%`, stage: r.stage, state: r.state, exclude_reason: r.exclude_reason,
    display: r.exclude_reason ? `제외 · ${EXCLUDE_KO[r.exclude_reason] || r.exclude_reason}` : `${STAGE_KO[r.stage]} · ${r.state === 'final' ? '확정' : '진행 중'}`,
  }));
}

export async function me(env, userId) {
  const [prices, list, excl] = await Promise.all([planPrices(env), accountStats(env), exclusionCounts(env)]);
  const plans = planStats(list, env, prices, excl);
  const mine = list.filter(a => a.user_id === userId);
  const fps = mine.map(a => a.account_fp);
  const windows = fps.length ? (await env.DB.prepare(`SELECT w.*, a.public_tag FROM windows w JOIN claude_accounts a ON a.account_fp = w.account_fp
    WHERE w.account_fp IN (${fps.map(() => '?').join(',')}) ORDER BY w.t_base DESC LIMIT 200`).bind(...fps).all()).results : [];
  const accounts = mine.map(a => {
    const ws = windows.filter(w => w.account_fp === a.account_fp);
    // 게이지마다 가장 최근 창 하나
    const latest = ['7d', '5h'].map(g => ws.filter(w => w.gauge === g).sort((x, y) => y.t_end - x.t_end)[0]).filter(Boolean).map(w => ({ gauge: w.gauge, g_end: w.g_end, t_end: w.t_end }));
    const planMed = a.plan ? plans[a.plan].median_usd_per_100pct : null;
    return { tag: a.tag, plan: a.plan, tier: a.tier, eligible: a.eligible, ineligible: a.ineligible, probation: a.probation, stage: a.stage,
      weekly_pct: a.weekly_pct, min_weekly_pct: a.min_weekly_pct, windows: a.windows, usd_per_100pct: a.usd_per_100pct, range_lo: a.range_lo, range_hi: a.range_hi,
      five_hour_usd_per_100pct: a.five_hour_usd_per_100pct, monthly_value: a.monthly_value, value_multiple: a.value_multiple,
      effective_usd_per_api_usd: a.effective_usd_per_api_usd, rank: a.rank ?? null, n_in_plan: a.n_in_plan ?? plans[a.plan]?.n ?? 0,
      top_pct: a.top_pct ?? null, vs_plan_median: planMed && a.usd_per_100pct ? a.usd_per_100pct / planMed - 1 : null, latest };
  });
  const devices = (await env.DB.prepare('SELECT id, name, os, client_version, collector, created_at, last_seen, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()).results;
  return { accounts, windows: windows.map(({ account_fp, ...w }) => w), devices, plans };
}

export async function snapshot(env) {
  const [prices, list, excl] = await Promise.all([planPrices(env), accountStats(env), exclusionCounts(env)]);
  const plans = planStats(list, env, prices, excl);
  const date = new Date().toISOString().slice(0, 10);
  const stmts = Object.values(plans).map(p => env.DB.prepare(`INSERT OR REPLACE INTO stats_daily (date, plan, gauge, n_accounts, n_intervals,
    mean_usd_per_100pct, min, max, p25, p75, monthly_value_usd, value_multiple, weights_json) VALUES (?, ?, '7d', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(date, p.plan, p.n, p.median_usd_per_100pct, p.range_lo, p.range_hi, p.p25, p.p75, p.monthly_value, p.value_multiple, JSON.stringify({ stages: p.stages, exclusions: p.exclusions })));
  await env.DB.batch(stmts);
}
