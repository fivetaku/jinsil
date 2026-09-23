// CLI 기기 코드 연결 (gh auth login 방식). 사용자가 비밀값을 복사·붙여넣기 할 일이 없다.
import { json, sha256, randomToken, userCode, readJson } from './util.js';

const CODE_TTL_MS = 10 * 60000;
const clip = (s, n) => String(s ?? '').slice(0, n);

export async function code(req, env) {
  const body = await readJson(req, 4096);
  const meta = { name: clip(body.name, 64), os: clip(body.os, 32), client_version: clip(body.client_version, 16) };
  const deviceCode = randomToken(32);
  const uc = userCode();
  await env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO device_codes (device_code_hash, user_code, expires_at, device_meta) VALUES (?, ?, ?, ?)')
    .bind(await sha256(deviceCode), uc, Date.now() + CODE_TTL_MS, JSON.stringify(meta)).run();
  const origin = new URL(req.url).origin;
  return json({ device_code: deviceCode, user_code: uc, verify_url: `${origin}/link?code=${uc}`, interval: 5, expires_in: CODE_TTL_MS / 1000 });
}

export async function token(req, env) {
  const body = await readJson(req, 4096);
  if (typeof body.device_code !== 'string') return json({ error: 'invalid_request' }, 400);
  const h = await sha256(body.device_code);
  const row = await env.DB.prepare('SELECT * FROM device_codes WHERE device_code_hash = ?').bind(h).first();
  if (!row || row.expires_at < Date.now()) return json({ error: 'expired_token' }, 410);
  if (row.denied) { await env.DB.prepare('DELETE FROM device_codes WHERE device_code_hash = ?').bind(h).run(); return json({ error: 'access_denied' }, 403); }
  if (!row.approved_user_id) return json({ error: 'authorization_pending' }, 428);
  const meta = JSON.parse(row.device_meta);
  const deviceToken = randomToken(32);
  const id = crypto.randomUUID();
  // 1회용: 토큰 발급과 동시에 코드 삭제
  await env.DB.batch([
    env.DB.prepare('DELETE FROM device_codes WHERE device_code_hash = ?').bind(h),
    // 같은 사용자가 같은 PC(호스트명·OS)를 다시 연결하면 예전 연결을 대체한다 — setup 재실행으로 PC가 여러 대로 잡히지 않게.
    env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND name = ? AND os = ? AND revoked_at IS NULL')
      .bind(Date.now(), row.approved_user_id, meta.name, meta.os),
    env.DB.prepare('INSERT INTO devices (id, user_id, token_hash, name, os, client_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, row.approved_user_id, await sha256(deviceToken), meta.name, meta.os, meta.client_version, Date.now()),
  ]);
  return json({ device_token: deviceToken, device_id: id });
}

export async function pendingCode(env, uc) {
  const row = await env.DB.prepare('SELECT user_code, expires_at, approved_user_id, denied, device_meta FROM device_codes WHERE user_code = ?').bind(String(uc || '').toUpperCase()).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { ...row, meta: JSON.parse(row.device_meta) };
}
export async function decide(env, uc, userId, approve) {
  const r = await env.DB.prepare(approve
    ? 'UPDATE device_codes SET approved_user_id = ? WHERE user_code = ? AND expires_at > ? AND approved_user_id IS NULL AND denied = 0'
    : 'UPDATE device_codes SET denied = 1 WHERE user_code = ? AND expires_at > ? AND approved_user_id IS NULL AND ? IS NOT NULL')
    .bind(...(approve ? [userId, uc, Date.now()] : [uc, Date.now(), userId])).run();
  return r.meta.changes > 0;
}

export async function deviceFromBearer(req, env) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const row = await env.DB.prepare(`SELECT d.id, d.user_id, d.revoked_at, u.status FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`)
    .bind(await sha256(m[1])).first();
  if (!row || row.revoked_at || row.status !== 'active') return null;
  return row;
}

export async function revoke(req, env) {
  const d = await deviceFromBearer(req, env);
  if (!d) return json({ error: 'unauthorized' }, 401);
  await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(Date.now(), d.id).run();
  return json({ ok: true });
}
