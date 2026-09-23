// Claude Code 로그인 토큰 읽기(claudeAiOauth만).
// - macOS: 키체인 "Claude Code-credentials"(현재 사용자 계정 항목 → 계정 지정 없는 항목, 두 번만). 없으면 파일로 폴백.
// - Linux·Windows: `CLAUDE_CONFIG_DIR` 또는 ~/.claude 의 .credentials.json (Windows: %USERPROFILE%\.claude\.credentials.json).
// - 토큰은 반환값으로만 다루고 로그·파일·명령 인수·환경변수에 남기지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SERVICE = 'Claude Code-credentials';
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const credentialsFile = () => path.join(claudeDir(), '.credentials.json');

function security(args) {
  return new Promise(resolve => execFile('/usr/bin/security', args, { timeout: 10000, maxBuffer: 1 << 20 }, (e, out) => resolve(e ? null : out)));
}
function parse(text) {
  try {
    const o = JSON.parse(String(text).trim()).claudeAiOauth;
    if (o && typeof o.accessToken === 'string') return { token: o.accessToken, expiresAt: Number(o.expiresAt) || null };
  } catch {}
  return null;
}
export async function readClaudeToken({ platform = process.platform, run = security, file = credentialsFile() } = {}) {
  if (platform === 'darwin') {
    for (const acct of [os.userInfo().username, null]) {
      const out = await run(['find-generic-password', '-s', SERVICE, ...(acct ? ['-a', acct] : []), '-w']);
      const r = out && parse(out);
      if (r) return { ...r, source: 'keychain' };
    }
  }
  try { const r = parse(fs.readFileSync(file, 'utf8')); if (r) return { ...r, source: 'file' }; } catch {}
  return { token: null, reason: 'not_found' };
}
// 만료·401 때 직접 갱신하지 않고 Claude Code에 맡긴다(`claude auth status`가 필요 시 갱신). Windows의 claude는 .cmd라 셸 경유.
export function refreshViaClaude({ bin = process.env.JINSIL_CLAUDE_BIN || 'claude' } = {}) {
  return new Promise(resolve => execFile(bin, ['auth', 'status'], { timeout: 20000, shell: process.platform === 'win32' }, e => resolve(!e)));
}
