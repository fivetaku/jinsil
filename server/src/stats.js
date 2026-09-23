// 집계: 계정별 주간 100% 환산 → 요금제별 평균·가성비 배수·순위·스티커. 계정당 한 표.
import { planOf, PLAN_LABEL, WEEKS_PER_MONTH } from './util.js';

const PLANS = ['pro', 'max5x', 'max20x', 'team_standard', 'team_premium'];
const MIN_WEEKLY_PCT = 3;             // 순위·통계 편입 최소 주간 게이지 합(%p)
const ADVERT_GAP = 0.8;               // 가치 배수가 가격 배수의 80% 미만이면 '광고보다 적음'
// 이 규칙의 flag는 해당 계정의 잘못이 아니다(다른 사용자가 이 계정 지문으로 제출 시도).
const NON_PENALTY_RULES = ['account_bound_to_other_user'];

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

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
    env.DB.prepare(`SELECT account_fp, gauge, SUM(g_end - g_start) AS pct, SUM(cost_usd) AS cost, COUNT(*) AS n
      FROM intervals WHERE status = 'accepted' AND cost_usd IS NOT NULL GROUP BY account_fp, gauge`).all(),
    env.DB.prepare(`SELECT DISTINCT account_fp FROM flags WHERE account_fp IS NOT NULL AND (decision IS NULL OR decision <> 'dismissed')
      AND rule NOT IN (${NON_PENALTY_RULES.map(() => '?').join(',')})`).bind(...NON_PENALTY_RULES).all(),
  ]);
  const flaggedSet = new Set(flagged.map(r => r.account_fp));
  const by = new Map(accounts.map(a => [a.account_fp, { ...a, plan: planOf(a.tier_latest), weekly_pct: 0, weekly_cost: 0, five_pct: 0, five_cost: 0 }]));
  for (const s of sums) {
    const a = by.get(s.account_fp);
    if (!a) continue;
    if (s.gauge === '7d') { a.weekly_pct = s.pct; a.weekly_cost = s.cost; } else { a.five_pct = s.pct; a.five_cost = s.cost; }
  }
  const list = [...by.values()].map(a => {
    const price = a.plan ? prices[a.plan] : undefined;
    const w100 = a.weekly_pct > 0 ? a.weekly_cost / a.weekly_pct * 100 : null;
    const monthly = w100 === null ? null : w100 * WEEKS_PER_MONTH;
    let ineligible = null;
    if (!a.plan || !price) ineligible = 'plan_unknown';
    else if (a.weekly_pct < MIN_WEEKLY_PCT) ineligible = 'insufficient_weekly_data';
    else if (flaggedSet.has(a.account_fp)) ineligible = 'flagged';
    else if (now - a.first_seen < probationMs) ineligible = 'probation';
    return { account_fp: a.account_fp, user_id: a.user_id, tag: a.public_tag, plan: a.plan, tier: a.tier_latest, price: price ?? null,
      weekly_pct: a.weekly_pct, weekly_cost: a.weekly_cost, usd_per_100pct: w100,
      five_hour_usd_per_100pct: a.five_pct > 0 ? a.five_cost / a.five_pct * 100 : null,
      monthly_value: monthly, value_multiple: monthly !== null && price ? monthly / price : null,
      effective_usd_per_api_usd: monthly ? price / monthly : null, probation: now - a.first_seen < probationMs,
      eligible: !ineligible, ineligible };
  });
  // 요금제별 이상치(IQR 3배) 제외 후 순위
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

export function planStats(list, env, prices) {
  const min = Number(env.MIN_ACCOUNTS ?? 5);
  const out = {};
  for (const plan of PLANS) {
    const el = list.filter(a => a.plan === plan && a.eligible);
    const v = el.map(a => a.usd_per_100pct).sort((x, y) => x - y);
    const mean = v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    const five = el.map(a => a.five_hour_usd_per_100pct).filter(x => x !== null);
    const monthly = mean === null ? null : mean * WEEKS_PER_MONTH;
    out[plan] = { plan, label: PLAN_LABEL[plan], price: prices[plan] ?? null, n: el.length, min_accounts: min,
      participants: list.filter(a => a.plan === plan).length, shown: el.length >= min,
      mean_usd_per_100pct: mean, min: v[0] ?? null, max: v.at(-1) ?? null, p25: quantile(v, 0.25), p75: quantile(v, 0.75),
      five_hour_mean_usd_per_100pct: five.length ? five.reduce((s, x) => s + x, 0) / five.length : null,
      monthly_value: monthly, value_multiple: monthly !== null && prices[plan] ? monthly / prices[plan] : null };
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
    if (!p.shown) { s.push({ kind: 'waiting', text: `측정 대기 · 참여 ${p.n}/${p.min_accounts}` }); out[p.plan] = s; continue; }
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
  const prices = await planPrices(env);
  const list = await accountStats(env);
  const plans = planStats(list, env, prices);
  const ranking = {};
  // 공개 기준(계정 수) 미달 요금제는 순위도 숨긴다 — 카드가 '측정 대기'인데 개인 값이 순위표로 새지 않게.
  for (const plan of PLANS) ranking[plan] = !plans[plan].shown ? [] : list.filter(a => a.plan === plan && a.eligible).sort((a, b) => a.rank - b.rank)
    .map(a => ({ rank: a.rank, tag: a.tag, value_multiple: a.value_multiple, usd_per_100pct: a.usd_per_100pct, weekly_pct: a.weekly_pct }));
  const { baseline, stickers: st } = stickers(plans);
  const priceVer = await env.DB.prepare('SELECT COUNT(*) AS n FROM prices WHERE verified_at IS NULL').first();
  // 측정 중: 활성 기기를 연결한 사람·PC 수(제출 전 포함). 요금제별 공개 기준(제출 계정 수)과는 별개.
  const measuring = await env.DB.prepare('SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS devices FROM devices WHERE revoked_at IS NULL').first();
  return { plans, ranking, stickers: st, baseline, measuring: { users: measuring.users, devices: measuring.devices }, price_status: priceVer.n ? 'provisional' : 'verified',
    note: '매주 100%를 다 썼을 때의 이론적 상한 · API 정가 환산' };
}

export async function feed(env, limit = 30) {
  const probationMs = Number(env.PROBATION_HOURS ?? 24) * 3600000;
  const { results } = await env.DB.prepare(`SELECT i.created_at, i.gauge, i.g_start, i.g_end, i.status, i.exclude_reason, i.usd_per_pct, i.tier,
    a.public_tag, a.first_seen FROM intervals i JOIN claude_accounts a ON a.account_fp = i.account_fp ORDER BY i.created_at DESC LIMIT ?`).bind(limit).all();
  return results.map(r => ({
    at: new Date(Math.floor(r.created_at / 60000) * 60000).toISOString(), tag: r.public_tag, plan: planOf(r.tier),
    gauge: r.gauge, range: `${r.g_start}%→${r.g_end}%`,
    // 구간 하나의 1%당 값은 게이지 반영 지연 때문에 크게 튄다 — 공개 피드에는 싣지 않고 계정 합산값만 쓴다.
    display: r.status === 'accepted' ? (r.created_at - r.first_seen < probationMs ? '검증 중(24시간)' : '반영')
      : r.status === 'flagged' ? '검토 중' : '통계 제외',
    status: r.status,
  }));
}

export async function me(env, userId) {
  const prices = await planPrices(env);
  const list = await accountStats(env);
  const plans = planStats(list, env, prices);
  const mine = list.filter(a => a.user_id === userId);
  const accounts = await Promise.all(mine.map(async a => {
    const last = await env.DB.prepare('SELECT gauge, g_end, t_end FROM intervals WHERE account_fp = ? ORDER BY t_end DESC, created_at DESC LIMIT 2').bind(a.account_fp).all();
    const planMean = a.plan ? plans[a.plan].mean_usd_per_100pct : null;
    return { tag: a.tag, plan: a.plan, tier: a.tier, eligible: a.eligible, ineligible: a.ineligible, probation: a.probation,
      weekly_pct: a.weekly_pct, usd_per_100pct: a.usd_per_100pct, monthly_value: a.monthly_value, value_multiple: a.value_multiple,
      effective_usd_per_api_usd: a.effective_usd_per_api_usd, rank: a.rank ?? null, n_in_plan: a.n_in_plan ?? plans[a.plan]?.n ?? 0,
      top_pct: a.top_pct ?? null, vs_plan_mean: planMean && a.usd_per_100pct ? a.usd_per_100pct / planMean - 1 : null,
      latest: last.results };
  }));
  const fps = mine.map(a => a.account_fp);
  const q = fps.length ? `SELECT i.interval_id, i.t_start, i.t_end, i.gauge, i.g_start, i.g_end, i.status, i.exclude_reason, i.usd_per_pct, i.cost_usd,
    i.requests, i.created_at, a.public_tag FROM intervals i JOIN claude_accounts a ON a.account_fp = i.account_fp
    WHERE i.account_fp IN (${fps.map(() => '?').join(',')}) ORDER BY i.t_end DESC LIMIT 200` : null;
  const intervals = q ? (await env.DB.prepare(q).bind(...fps).all()).results : [];
  const devices = (await env.DB.prepare('SELECT id, name, os, client_version, created_at, last_seen, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()).results;
  return { accounts, intervals, devices, plans };
}

// 일일 스냅샷(cron). 공개 API의 정본은 실시간 계산이며 이 표는 추이 기록용이다.
export async function snapshot(env) {
  const prices = await planPrices(env);
  const list = await accountStats(env);
  const plans = planStats(list, env, prices);
  const date = new Date().toISOString().slice(0, 10);
  const n = await env.DB.prepare(`SELECT tier, COUNT(*) AS n FROM intervals WHERE status='accepted' AND gauge='7d' GROUP BY tier`).all();
  const stmts = Object.values(plans).map(p => env.DB.prepare(`INSERT OR REPLACE INTO stats_daily (date, plan, gauge, n_accounts, n_intervals,
    mean_usd_per_100pct, min, max, p25, p75, monthly_value_usd, value_multiple, weights_json) VALUES (?, ?, '7d', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .bind(date, p.plan, p.n, n.results.filter(r => planOf(r.tier) === p.plan).reduce((s, r) => s + r.n, 0), p.mean_usd_per_100pct, p.min, p.max, p.p25, p.p75, p.monthly_value, p.value_multiple));
  stmts.push(env.DB.prepare('DELETE FROM account_stats'));
  for (const a of list) stmts.push(env.DB.prepare(`INSERT INTO account_stats (account_fp, tier, weekly_pct_sum, cost_sum, usd_per_100pct, value_multiple,
    effective_usd_per_api_usd, rank_in_tier, n_in_tier, eligible, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(a.account_fp, a.tier, a.weekly_pct, a.weekly_cost, a.usd_per_100pct, a.value_multiple, a.effective_usd_per_api_usd, a.rank ?? null, a.n_in_plan ?? null, a.eligible ? 1 : 0, Date.now()));
  await env.DB.batch(stmts);
}
