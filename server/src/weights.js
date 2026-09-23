// M5 보조 지표(01_PRD 3-7): 토큰 종류별 게이지 가중치 회귀 + 게이지 반영 지연 추정. 공개 보조 지표이며 요금제 값 계산에는 쓰지 않는다.
// - 가중치: 창마다 Δ게이지 ≈ Σ_k w_k·C_k (C_k = 그 창의 성분 k API 정가 비용). 절편 없는 최소제곱.
//   공개값은 상대 가중치 r_k = w_k / (ΣΔ/ΣC) — 1보다 크면 게이지가 그 성분을 API 정가 비율보다 무겁게 센다는 뜻.
// - 지연: 창마다 L ∈ {0,5,…,30}분을 시험해 g(t)−g0 ≈ a·K(t−L) (K=누적 비용)의 잔차가 가장 작은 L. 창별 최적 L의 중앙값.
// - 표본이 기준 미만이면 null(측정 대기). 모르는 값은 0으로 채우지 않는다.
export const WEIGHT_KEYS = ['input', 'output', 'cache_read', 'cache_write'];
export const MIN_WINDOWS = 30, MIN_ACCOUNTS = 5;
const LAGS = [0, 5, 10, 15, 20, 25, 30];

// 가우스 소거(부분 피벗). 특이 행렬이면 null.
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// rows: [{ account, delta, parts: {input, output, cache_read, cache_write} (USD) }]
export function fitWeights(rows, { minWindows = MIN_WINDOWS, minAccounts = MIN_ACCOUNTS } = {}) {
  const ok = rows.filter(r => r.delta > 0 && WEIGHT_KEYS.every(k => Number.isFinite(r.parts[k])));
  const accounts = new Set(ok.map(r => r.account)).size;
  const base = { windows: ok.length, accounts, min_windows: minWindows, min_accounts: minAccounts };
  if (ok.length < minWindows || accounts < minAccounts) return { ...base, status: 'waiting', relative: null };
  const K = WEIGHT_KEYS.length, A = Array.from({ length: K }, () => Array(K).fill(0)), b = Array(K).fill(0);
  let sumD = 0, sumC = 0;
  for (const r of ok) {
    const x = WEIGHT_KEYS.map(k => r.parts[k]);
    for (let i = 0; i < K; i++) { b[i] += x[i] * r.delta; for (let j = 0; j < K; j++) A[i][j] += x[i] * x[j]; }
    sumD += r.delta; sumC += x.reduce((s, v) => s + v, 0);
  }
  const w = solve(A, b);
  if (!w || !(sumC > 0)) return { ...base, status: 'unidentifiable', relative: null };
  const avg = sumD / sumC;
  // 적합도(비중심 R²): 절편 없는 모형이라 Σy² 기준
  let sse = 0, sst = 0;
  for (const r of ok) { const y = WEIGHT_KEYS.reduce((s, k, i) => s + w[i] * r.parts[k], 0); sse += (r.delta - y) ** 2; sst += r.delta ** 2; }
  return { ...base, status: 'ok', relative: Object.fromEntries(WEIGHT_KEYS.map((k, i) => [k, w[i] / avg])), r2: sst > 0 ? 1 - sse / sst : null };
}

// 구성: 참여자 창 전체의 성분별 API 정가 비용 비중(계정 수 기준 미달이면 null)
export function composition(rows, { minAccounts = MIN_ACCOUNTS } = {}) {
  const ok = rows.filter(r => WEIGHT_KEYS.every(k => Number.isFinite(r.parts[k])));
  if (new Set(ok.map(r => r.account)).size < minAccounts) return null;
  const tot = Object.fromEntries(WEIGHT_KEYS.map(k => [k, ok.reduce((s, r) => s + r.parts[k], 0)]));
  const all = Object.values(tot).reduce((s, v) => s + v, 0);
  return all > 0 ? Object.fromEntries(WEIGHT_KEYS.map(k => [k, tot[k] / all])) : null;
}

// 창 하나의 최적 지연(분). samples: [[t, g]], bins: [[t, cost]] (t는 ms). 판단 불가면 null.
export function bestLag(samples, bins) {
  if (samples.length < 4 || !bins.length) return null;
  const g0 = samples[0][1], rise = samples.at(-1)[1] - g0;
  if (!(rise > 0)) return null;
  const sorted = [...bins].sort((a, b) => a[0] - b[0]);
  const cum = t => sorted.reduce((s, [bt, c]) => (bt <= t ? s + c : s), 0);
  let best = null;
  for (const L of LAGS) {
    const xs = samples.map(([t]) => cum(t - L * 60000)), ys = samples.map(([, g]) => g - g0);
    const sxx = xs.reduce((s, x) => s + x * x, 0);
    if (!(sxx > 0)) continue;
    const a = xs.reduce((s, x, i) => s + x * ys[i], 0) / sxx;
    const sse = xs.reduce((s, x, i) => s + (ys[i] - a * x) ** 2, 0);
    if (a > 0 && (!best || sse < best.sse - 1e-12)) best = { L, sse };
  }
  return best ? best.L : null;
}

export function lagSummary(lags, { minWindows = 10 } = {}) {
  const v = lags.filter(x => x !== null).sort((a, b) => a - b);
  if (v.length < minWindows) return { status: 'waiting', windows: v.length, min_windows: minWindows, median_min: null };
  return { status: 'ok', windows: v.length, min_windows: minWindows, median_min: v[Math.floor((v.length - 1) / 2)] };
}
