// 공통 유틸: 해시·난수·응답·쿠키.
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
export const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'", ...headers } });
export const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export function userCode() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  const s = [...a].map(b => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setCookie(name, value, { maxAge, secure = true } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}`;
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export async function readJson(req, limit = 256 * 1024) {
  const text = await req.text();
  if (text.length > limit) throw Object.assign(Error('body_too_large'), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(Error('invalid_json'), { status: 400 }); }
}
export async function readForm(req) {
  const f = await req.formData();
  return Object.fromEntries(f.entries());
}
export const planOf = tier => !tier ? null : /max_20x/.test(tier) ? 'max20x' : /max_5x/.test(tier) ? 'max5x' : /pro/.test(tier) ? 'pro' : null;
export const PLAN_LABEL = { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x' };
export const WEEKS_PER_MONTH = 30 / 7;
