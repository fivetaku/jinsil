// 클진요 Worker 라우터.
import { json, html, redirect, readForm, setCookie } from './util.js';
import * as auth from './auth.js';
import * as device from './device.js';
import { syncPrices } from './pricing.js';
import * as intervals from './intervals.js';
import * as bins from './bins.js';
import * as stats from './stats.js';
import * as pages from './pages.js';

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname, m = req.method;
  // CLI API
  if (p === '/device/code' && m === 'POST') return device.code(req, env);
  if (p === '/device/token' && m === 'POST') return device.token(req, env);
  if (p === '/device/revoke' && m === 'POST') return device.revoke(req, env);
  if (p === '/v2/bins' && m === 'POST') return bins.submit(req, env);
  // 0.1.x 구간 제출은 0.2에서 중단: 측정 방식이 바뀌어 업데이트가 필요하다.
  if (p === '/v1/intervals' && m === 'POST') return json({ status: 'rejected', reason: 'upgrade_required', message: 'npx jinsil@latest setup' }, 426);
  // 공개 API
  if (p === '/api/stats' && m === 'GET') return json(await stats.publicStats(env), 200, { 'cache-control': 'public, max-age=60' });
  if (p === '/api/feed' && m === 'GET') return json(await stats.feed(env, 30), 200, { 'cache-control': 'public, max-age=30' });
  // 로그인
  if (p === '/auth/google') return auth.start(req, env);
  if (p === '/auth/callback') return auth.callback(req, env);
  if (p === '/auth/logout' && m === 'POST') return auth.logout(req, env);
  if (p.startsWith('/dev-idp/')) return auth.devIdp(req, env);
  // 웹 페이지
  if (p === '/' && m === 'GET') return pages.home(req, env);
  if (p === '/methodology' && m === 'GET') return pages.methodology(req, env);
  const user = await auth.currentUser(req, env);
  if (p === '/link') {
    if (!user) return redirect(`/auth/google?next=${encodeURIComponent(p + url.search)}`);
    if (m === 'GET') return pages.link(req, env, user, await device.pendingCode(env, url.searchParams.get('code')));
    if (m === 'POST') {
      const f = await readForm(req);
      if (f.csrf !== user.csrf) return html('<p>요청 확인 실패</p>', 403);
      const ok = await device.decide(env, String(f.user_code || '').toUpperCase(), user.id, f.action === 'approve');
      return pages.linkDone(req, env, ok, f.action === 'approve');
    }
  }
  if (p.startsWith('/me')) {
    if (!user) return redirect(`/auth/google?next=${encodeURIComponent(p)}`);
    if (p === '/me' && m === 'GET') return pages.me(req, env, user, await stats.me(env, user.id));
    if (p === '/me.json') return json(await stats.me(env, user.id));
    if (p === '/me/export.csv' && m === 'GET') return pages.exportCsv(await stats.me(env, user.id));
    if (p === '/me/report' && m === 'GET') return pages.report(req, env, await stats.me(env, user.id));
    if (m === 'POST') {
      const f = await readForm(req);
      if (f.csrf !== user.csrf) return html('<p>요청 확인 실패</p>', 403);
      if (p === '/me/devices/revoke') {
        await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(Date.now(), String(f.device_id), user.id).run();
        return redirect('/me');
      }
      if (p === '/me/delete' && f.confirm === 'DELETE') {
        // 내 제출 구간·계정 결속·기기·세션·사용자 전부 삭제 → 공개 통계에서 빠진다.
        await env.DB.batch([
          env.DB.prepare('DELETE FROM interval_tokens WHERE interval_id IN (SELECT interval_id FROM intervals WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?))').bind(user.id),
          env.DB.prepare('DELETE FROM intervals WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?)').bind(user.id),
          env.DB.prepare('DELETE FROM usage_bins WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?)').bind(user.id),
          env.DB.prepare('DELETE FROM gauge_samples WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?)').bind(user.id),
          env.DB.prepare('DELETE FROM windows WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?)').bind(user.id),
          env.DB.prepare('DELETE FROM flags WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?)').bind(user.id),
          env.DB.prepare('DELETE FROM account_stats WHERE account_fp IN (SELECT account_fp FROM claude_accounts WHERE user_id = ?)').bind(user.id),
          env.DB.prepare('DELETE FROM claude_accounts WHERE user_id = ?').bind(user.id),
          env.DB.prepare('DELETE FROM devices WHERE user_id = ?').bind(user.id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
        ]);
        return redirect('/', { 'set-cookie': setCookie('jinsil_session', '', { maxAge: 0, secure: url.protocol === 'https:' }) });
      }
    }
  }
  return html(pages.notFound(), 404);
}

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) {
      // 요청 본문·인증값을 로그에 남기지 않는다. 오류 종류만.
      console.error('jinsil_error', e?.message);
      return json({ error: 'internal_error' }, 500);
    }
  },
  async scheduled(_event, env) {
    const r = await syncPrices(env).catch(e => ({ ok: false, reason: String(e?.message || e) }));
    console.log('price_sync', JSON.stringify({ ok: r.ok, models: r.models, changed: r.changed, held: r.held?.length, missing: r.missing, reason: r.reason }));
    await stats.snapshot(env);
  },
};
