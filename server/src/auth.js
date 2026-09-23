// 웹 로그인: Google OAuth(OIDC 코드 흐름). 로컬 개발은 DEV_IDP=1일 때만 켜지는 모의 IdP가 같은 흐름을 흉내 낸다.
// 저장하는 것은 Google sub(계정 식별자)뿐. 이메일·이름은 받지도 저장하지도 않는다(scope=openid).
import { redirect, cookies, setCookie, sha256, randomToken, html, esc } from './util.js';

const SESSION_DAYS = 30;
const secureCookie = url => url.protocol === 'https:';

export async function currentUser(req, env) {
  const sid = cookies(req).jinsil_session;
  if (!sid) return null;
  const row = await env.DB.prepare(`SELECT s.user_id, s.csrf, u.status FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ? AND s.expires_at > ?`).bind(await sha256(sid), Date.now()).first();
  if (!row || row.status !== 'active') return null;
  return { id: row.user_id, csrf: row.csrf };
}

function redirectUri(url) { return `${url.origin}/auth/callback`; }
const safeNext = n => (typeof n === 'string' && /^\/[a-zA-Z0-9/_?=&%.-]*$/.test(n) && !n.startsWith('//')) ? n : '/me';

export async function start(req, env) {
  const url = new URL(req.url);
  if (!env.GOOGLE_CLIENT_ID) return html('<p>로그인이 아직 설정되지 않았습니다.</p>', 503);
  const state = randomToken(24);
  const next = safeNext(url.searchParams.get('next'));
  const auth = new URL(env.DEV_IDP === '1' && env.GOOGLE_AUTH_URL.startsWith('/') ? url.origin + env.GOOGLE_AUTH_URL : env.GOOGLE_AUTH_URL);
  auth.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code',
    scope: 'openid', state, prompt: 'select_account' }).toString();
  return redirect(auth.toString(), { 'set-cookie': setCookie('jinsil_oauth', `${state}|${next}`, { maxAge: 600, secure: secureCookie(url) }) });
}

function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1];
  if (!part) throw Error('bad_id_token');
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
}

export async function callback(req, env) {
  const url = new URL(req.url);
  const [state, next] = (cookies(req).jinsil_oauth || '').split('|');
  if (!state || url.searchParams.get('state') !== state) return html('<p>로그인 상태 확인에 실패했습니다. 다시 시도하세요.</p>', 400);
  const code = url.searchParams.get('code');
  if (!code) return html('<p>로그인이 취소됐습니다.</p>', 400);
  const tokenUrl = env.DEV_IDP === '1' && env.GOOGLE_TOKEN_URL.startsWith('/') ? url.origin + env.GOOGLE_TOKEN_URL : env.GOOGLE_TOKEN_URL;
  const r = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri(url), grant_type: 'authorization_code' }) });
  if (!r.ok) return html('<p>로그인 토큰 교환에 실패했습니다.</p>', 502);
  const tok = await r.json();
  // 토큰 엔드포인트에서 TLS로 직접 받은 id_token — OIDC Core 3.1.3.7에 따라 서명 대신 iss/aud/exp를 확인한다.
  let claims;
  try { claims = decodeJwtPayload(tok.id_token); } catch { return html('<p>로그인 응답이 올바르지 않습니다.</p>', 502); }
  const issOk = ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || (env.DEV_IDP === '1' && claims.iss === 'jinsil-dev-idp');
  if (!issOk || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp * 1000 > Date.now()) || typeof claims.sub !== 'string' || !claims.sub)
    return html('<p>로그인 응답 검증에 실패했습니다.</p>', 401);
  let user = await env.DB.prepare('SELECT id, status FROM users WHERE google_sub = ?').bind(claims.sub).first();
  if (!user) {
    user = { id: crypto.randomUUID(), status: 'active' };
    await env.DB.prepare('INSERT INTO users (id, google_sub, status, created_at) VALUES (?, ?, ?, ?)').bind(user.id, claims.sub, 'active', Date.now()).run();
  }
  if (user.status !== 'active') return html('<p>이 계정은 정지됐습니다.</p>', 403);
  const sid = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(sid), user.id, randomToken(16), Date.now() + SESSION_DAYS * 86400000).run();
  const headers = new Headers({ location: safeNext(next) });
  headers.append('set-cookie', setCookie('jinsil_session', sid, { maxAge: SESSION_DAYS * 86400, secure: secureCookie(url) }));
  headers.append('set-cookie', setCookie('jinsil_oauth', '', { maxAge: 0, secure: secureCookie(url) }));
  return new Response(null, { status: 302, headers });
}

export async function logout(req, env) {
  const sid = cookies(req).jinsil_session;
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(sid)).run();
  return redirect('/', { 'set-cookie': setCookie('jinsil_session', '', { maxAge: 0, secure: new URL(req.url).protocol === 'https:' }) });
}

// ── 로컬 개발 전용 모의 IdP (DEV_IDP=1). 운영 설정에서는 404. ──
export async function devIdp(req, env) {
  const url = new URL(req.url);
  if (env.DEV_IDP !== '1') return new Response('not found', { status: 404 });
  if (url.pathname === '/dev-idp/authorize') {
    const p = url.searchParams;
    const sub = p.get('dev_sub');
    if (sub) {
      const back = new URL(p.get('redirect_uri'));
      back.search = new URLSearchParams({ code: `dev.${btoa(sub)}`, state: p.get('state') }).toString();
      return redirect(back.toString());
    }
    return html(`<form method="get"><h1>모의 Google 로그인 (로컬 전용)</h1>${[...p].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
      <input name="dev_sub" value="dev-user-1"><button>로그인</button></form>`);
  }
  if (url.pathname === '/dev-idp/token' && req.method === 'POST') {
    const f = new URLSearchParams(await req.text());
    const code = f.get('code') || '';
    if (!code.startsWith('dev.')) return new Response('bad code', { status: 400 });
    const b64 = s => btoa(JSON.stringify(s)).replace(/=+$/, '');
    const claims = { iss: 'jinsil-dev-idp', aud: f.get('client_id'), sub: atob(code.slice(4)), exp: Math.floor(Date.now() / 1000) + 600 };
    return new Response(JSON.stringify({ id_token: `${b64({ alg: 'none' })}.${b64(claims)}.` }), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
}
