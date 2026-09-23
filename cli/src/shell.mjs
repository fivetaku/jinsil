// `jinsil` 명령을 PATH에 등록한다. npx 실행은 끝나면 명령을 남기지 않으므로,
// setup이 고정 런타임을 가리키는 실행 파일(~/.jinsil/bin/jinsil)을 만들고 셸 설정에 PATH 한 줄을 넣는다.
// uninstall은 둘 다 되돌린다. 테스트는 JINSIL_RC_FILES(쉼표 구분)로 설정 파일 위치를 바꾼다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { home } from './paths.mjs';

const START = '# >>> jinsil >>>';
const END = '# <<< jinsil <<<';
export const binDir = () => path.join(home(), 'bin');
export const isWin = () => process.platform === 'win32';
export const shimPath = () => path.join(binDir(), isWin() ? 'jinsil.cmd' : 'jinsil');

export function rcFiles() {
  if (process.env.JINSIL_RC_FILES) return process.env.JINSIL_RC_FILES.split(',').filter(Boolean);
  if (isWin()) return []; // Windows는 셸 설정 대신 사용자 PATH 환경변수에 등록한다
  const h = os.homedir();
  const shell = path.basename(process.env.SHELL || '');
  if (shell === 'zsh') return [path.join(process.env.ZDOTDIR || h, '.zshrc')];
  if (shell === 'bash') return process.platform === 'darwin' ? [path.join(h, '.bash_profile'), path.join(h, '.bashrc')] : [path.join(h, '.bashrc')];
  if (shell === 'fish') return [path.join(h, '.config', 'fish', 'conf.d', 'jinsil.fish')];
  return [path.join(h, '.profile')];
}

const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 0.2: PATH 한 줄만 둔다. 0.1.x가 넣은 별칭(alias claude='jinsil claude' 등)은 블록째 다시 쓰면서 사라진다.
const block = file => `${START}\n${file.endsWith('.fish') ? `fish_add_path ${q(binDir())}` : `export PATH=${q(binDir())}:"$PATH"`}\n${END}\n`;
const strip = text => text.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n');

// Windows 사용자 PATH(레지스트리 HKCU\Environment) 읽기·쓰기. 1024자 제한이 있는 setx 대신 .NET API를 쓴다.
const psUserPath = cmd => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
function winPath(add) {
  if (process.env.JINSIL_SERVICE_DRYRUN === '1') return false;
  const cur = psUserPath("[Environment]::GetEnvironmentVariable('Path','User')");
  const parts = cur.split(';').filter(Boolean);
  const has = parts.some(p => p.toLowerCase() === binDir().toLowerCase());
  if (add === has) return false;
  const next = add ? [...parts, binDir()] : parts.filter(p => p.toLowerCase() !== binDir().toLowerCase());
  psUserPath(`[Environment]::SetEnvironmentVariable('Path', '${next.join(';').replace(/'/g, "''")}', 'User')`);
  return true;
}

export function installCommand({ node = process.execPath, entry }) {
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  if (isWin()) fs.writeFileSync(shimPath(), `@"${node}" "${entry}" %*\r\n`);
  else { fs.writeFileSync(shimPath(), `#!/bin/sh\nexec ${q(node)} ${q(entry)} "$@"\n`, { mode: 0o755 }); fs.chmodSync(shimPath(), 0o755); }
  const changed = [];
  if (isWin() && winPath(true)) changed.push('사용자 PATH');
  for (const f of rcFiles()) {
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const next = strip(cur).replace(/\s*$/, '') + (cur.trim() ? '\n\n' : '') + block(f);
    if (next !== cur) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, next); changed.push(f); }
  }
  return { shim: shimPath(), rc: rcFiles(), changed, onPath: (process.env.PATH || '').split(path.delimiter).includes(binDir()) };
}

export function uninstallCommand() {
  fs.rmSync(shimPath(), { force: true });
  if (isWin()) { try { winPath(false); } catch {} }
  for (const f of rcFiles()) {
    if (!fs.existsSync(f)) continue;
    const cur = fs.readFileSync(f, 'utf8');
    if (!cur.includes(START)) continue;
    const next = strip(cur).replace(/^\n+/, '').replace(/\n+$/, '\n');
    if (f.endsWith('jinsil.fish') && !next.trim()) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, next);
  }
}
