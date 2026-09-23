// 첨부 설계(2026-09-23)의 잠정 단가, $/Mtok: input, output, cache_write_5m, cache_write_1h, cache_read.
// 공식 가격·적용 날짜 확인 전에는 증거용 가격이 아니다. 로컬 표시용이며 서버 단가표가 정본이다.
export const PRICE_VERSION = 'attachment-2026-09-23-provisional';
export const PRICES = {
  'claude-opus-5-5': [4, 20, 5, 8, 0.2], 'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 10, 0.5], 'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-sonnet-5': [2, 10, 2.5, 4, 0.2], 'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  'claude-haiku-4-5-20251001': [1, 5, 1.25, 2, 0.1],
};
export const COMPONENTS = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];
export const TOKEN_KEYS = [...COMPONENTS, 'cache_write_unknown'];
// 가격을 모르면 null. 0으로 두지 않는다.
export function costOf(model, t) {
  const p = Object.hasOwn(PRICES, model) ? PRICES[model] : null;
  if (!p || t.cache_write_unknown > 0) return null;
  return COMPONENTS.reduce((s, k, i) => s + (t[k] || 0) * p[i], 0) / 1e6;
}
