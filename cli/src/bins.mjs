// 5분 bin: 메시지(transcript.mjs)를 5분 구간·모델별로 합산하고, 게이지 샘플의 계정 타임라인으로 계정을 붙인다.
// - 계정은 메시지 시각 앞뒤의 가장 가까운 샘플 계정이 같을 때만 확정. 다르거나 30분 안에 샘플이 없으면 attribution_unverified.
// - 같은 bin 키의 내용이 바뀌면 revision이 올라가고 다시 제출된다(서버 upsert).
import { createHash } from 'node:crypto';
import { TOKEN_KEYS } from './prices.mjs';

export const BIN_MS = 5 * 60000;
const NEAR_MS = 30 * 60000;
export const binStart = ts => Math.floor(ts / BIN_MS) * BIN_MS;

export function accountAt(ts, samples) {
  let before = null, after = null;
  for (const s of samples) {
    if (s.observed_at <= ts) { if (!before || s.observed_at > before.observed_at) before = s; }
    else if (!after || s.observed_at < after.observed_at) after = s;
  }
  const near = [before, after].filter(s => s && Math.abs(s.observed_at - ts) <= NEAR_MS);
  if (!near.length) return null;
  if (near.length === 2 && near[0].account_fp !== near[1].account_fp) return null;
  return { account_fp: near[0].account_fp, tier: near[0].tier };
}

export function buildBins(messages, samples) {
  const bins = new Map();
  for (const m of Object.values(messages)) {
    const acct = m.account_fp ? { account_fp: m.account_fp, tier: m.tier || null } : accountAt(m.ts, samples);
    const account_fp = acct?.account_fp || null;
    const key = `${account_fp || 'unverified'}|${binStart(m.ts)}|${m.model}`;
    let b = bins.get(key);
    if (!b) {
      b = { account_fp, tier: acct?.tier || null, bin_start: binStart(m.ts), model: m.model, messages: 0, sidechain_messages: 0, special: {},
        ...Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])) };
      bins.set(key, b);
    }
    for (const k of TOKEN_KEYS) b[k] += m.tokens[k] || 0;
    for (const [k, v] of Object.entries(m.special || {})) b.special[k] = (b.special[k] || 0) + v;
    b.messages++; if (m.sidechain) b.sidechain_messages++;
  }
  for (const b of bins.values()) b.hash = createHash('sha256').update(JSON.stringify([b.account_fp, b.bin_start, b.model, TOKEN_KEYS.map(k => b[k]), b.messages, b.special])).digest('hex').slice(0, 16);
  return [...bins.values()].sort((a, b) => a.bin_start - b.bin_start || a.model.localeCompare(b.model));
}
