// 한도 창 계산기(서버·CLI 공용, 순수 함수). 01_PRD 3-3.
// 창 = (계정, 게이지 5h|7d, resets_at). 첫 샘플 = 기준점, 게이지 최댓값에 처음 도달한 샘플 = 끝점.
// 비용 C = 기준~끝 사이 bin 비용. 경계 bin은 C⁻(완전히 안쪽)·C⁺(경계 bin 포함)로 나눠 범위를 낸다.
// 1%p 양자화 δ=1: 1%당 범위 = [C⁻/(D+1), C⁺/(D−1)], 점값 = C/D.
// 단계: D≥11 정밀, ≥8 보통, ≥5 잠정(등록), 그 미만은 below_min_delta(집계 안 함). 5h도 같은 단계를 쓰되 공개는 별도 표본 수.
// 제외 규칙은 값을 보기 전에 정한 것만: 요금제 변경, 외부 사용 의심, 비표준·미가격 토큰.
// (0.1의 '공백 뒤 상승'은 요청 장부 공백용 규칙. 대화 파일은 수집기가 꺼져도 남아 나중에 읽히고, 샘플 간격은 끝점이 실측이라 비율을 왜곡하지 않아 뺐다.)
export const BIN_MS = 5 * 60000;
export const CALC_VERSION = 'window-v1';
export const STAGES = [[11, 'precise'], [8, 'normal'], [5, 'provisional']];
const LAG_MS = 10 * 60000;        // 게이지 반영 지연 허용(이 안에 로컬 사용이 없는데 오르면 외부 사용 의심)
const SETTLE_MS = 30 * 60000;     // 마지막 활동 뒤 확정 대기

const stageOf = D => (STAGES.find(([min]) => D >= min) || [0, null])[1];
// resets_at 흔들림(초 단위)을 흡수: 10분 단위로 묶는다.
export const windowKey = resetsAt => Math.round(Date.parse(resetsAt) / 600000) * 600000;

// samples: [{observed_at, tier, gauge, utilization, resets_at}] (한 계정), bins: [{bin_start, cost|null, unpriced}]
export function computeWindows({ samples, bins, now = Date.now() }) {
  const out = [];
  const byWin = new Map();
  for (const s of samples) {
    if (!Number.isFinite(s.utilization) || !s.resets_at) continue;
    const k = `${s.gauge}|${windowKey(s.resets_at)}`;
    (byWin.get(k) || byWin.set(k, []).get(k)).push(s);
  }
  const sortedBins = [...bins].sort((a, b) => a.bin_start - b.bin_start);
  const binsIn = (a, b) => sortedBins.filter(x => x.bin_start < b && x.bin_start + BIN_MS > a);
  for (const [k, ss] of byWin) {
    ss.sort((a, b) => a.observed_at - b.observed_at);
    const [gauge, wk] = k.split('|');
    const base = ss[0];
    let max = base.utilization, end = base;
    for (const s of ss) if (s.utilization > max) { max = s.utilization; end = s; }
    const D = Math.round((max - base.utilization) * 100) / 100;
    const t0 = base.observed_at, t1 = end.observed_at;
    const inner = sortedBins.filter(x => x.bin_start >= t0 && x.bin_start + BIN_MS <= t1);
    const mid = sortedBins.filter(x => x.bin_start >= t0 - BIN_MS / 2 && x.bin_start < t1 - BIN_MS / 2);
    const outer = binsIn(t0 - BIN_MS, t1 + BIN_MS);
    const sum = arr => arr.some(x => x.cost === null) ? null : arr.reduce((s, x) => s + x.cost, 0);
    const C = sum(mid), Clo = sum(inner), Chi = sum(outer);
    // 제외 규칙
    let exclude = null;
    if (new Set(ss.map(s => s.tier)).size > 1) exclude = 'tier_changed';
    if (!exclude && [...mid, ...outer].some(x => x.unpriced || x.cost === null)) exclude = 'unpriced_tokens';
    if (!exclude) for (let i = 1; i < ss.length; i++) {
      const a = ss[i - 1], b = ss[i];
      if (b.utilization <= a.utilization || b.observed_at > t1) continue;
      if (!binsIn(a.observed_at - LAG_MS, b.observed_at).length) { exclude = 'external_usage_suspected'; break; }
    }
    const stage = stageOf(D);
    if (!exclude && !stage) exclude = 'below_min_delta';
    // 확정: 리셋 지남, 또는 마지막 활동 뒤 SETTLE_MS 지났고 마지막 두 샘플이 5분 이상 간격으로 같은 값
    const lastBin = sortedBins.filter(x => x.bin_start < t1 + SETTLE_MS).at(-1);
    const lastTwo = ss.slice(-2);
    const settled = lastTwo.length === 2 && lastTwo[0].utilization === lastTwo[1].utilization && lastTwo[1].observed_at - lastTwo[0].observed_at >= BIN_MS;
    const state = now >= Number(wk) ? 'final'
      : (settled && (!lastBin || now - (lastBin.bin_start + BIN_MS) >= SETTLE_MS)) ? 'final' : 'provisional';
    const r = v => (v === null ? null : Math.round(v * 1e6) / 1e6);
    out.push({ gauge, resets_at: new Date(Number(wk)).toISOString(), tier: base.tier, g_base: base.utilization, t_base: t0, g_end: max, t_end: t1,
      samples: ss.length, delta: D, cost: r(C), cost_lo: r(Clo), cost_hi: r(Chi),
      usd_per_pct: C !== null && D > 0 ? r(C / D) : null,
      usd_per_pct_lo: Clo !== null && D > 0 ? r(Clo / (D + 1)) : null,
      usd_per_pct_hi: Chi !== null && D > 1 ? r(Chi / (D - 1)) : null,
      stage, state, exclude_reason: exclude, calc_version: CALC_VERSION });
  }
  return out.sort((a, b) => a.t_base - b.t_base);
}
