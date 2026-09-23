// `jinsil` 명령을 PATH에 등록한다. npx 실행은 끝나면 명령을 남기지 않으므로,
// setup이 고정 런타임을 가리키는 실행 파일(~/.jinsil/bin/jinsil)을 만들고 셸 설정에 PATH 한 줄을 넣는다.
// uninstall은 둘 다 되돌린다. 테스트는 JINSIL_RC_FILES(쉼표 구분)로 설정 파일 위치를 바꾼다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from './paths.mjs';

const START = '# >>> jinsil >>>';
const END = '# <<< jinsil <<<';
export const binDir = () => path.join(home(), 'bin');
export const shimPath = () => path.join(binDir(), 'jinsil');

export function rcFiles() {
  if (process.env.JINSIL_RC_FILES) return process.env.JINSIL_RC_FILES.split(',').filter(Boolean);
  const h = os.homedir();
  const shell = path.basename(process.env.SHELL || '');
  if (shell === 'zsh') return [path.join(process.env.ZDOTDIR || h, '.zshrc')];
  if (shell === 'bash') return process.platform === 'darwin' ? [path.join(h, '.bash_profile'), path.join(h, '.bashrc')] : [path.join(h, '.bashrc')];
  if (shell === 'fish') return [path.join(h, '.config', 'fish', 'conf.d', 'jinsil.fish')];
  return [path.join(h, '.profile')];
}

const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 셸 설정에서 Anthropic으로 직접 가는 claude 별칭(값이 'claude'로 시작)을 찾는다.
// 라우터·다른 모델용(ANTHROPIC_BASE_URL=…, ocx, teamclaude …)은 값이 claude로 시작하지 않으므로 건드리지 않는다.
export function claudeAliases(text) {
  const out = new Map();
  for (const line of strip(text).split('\n')) {
    const m = /^\s*alias\s+([A-Za-z0-9_.-]+)=(?:'([^']*)'|"([^"]*)")\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const value = m[2] ?? m[3];
    if (/^claude(\s|$)/.test(value) && m[1] !== 'claude') out.set(m[1], value);
  }
  return out;
}
export function aliasLines(text, fish = false) {
  const found = claudeAliases(text);
  if (fish) return [`alias claude 'jinsil claude'`];
  if (!found.size) return [`alias claude='jinsil claude'`];
  return [...found].map(([name, value]) => `alias ${name}=${sq('jinsil ' + value)}`);
}
const block = (file, text, aliases) => {
  const fish = file.endsWith('.fish');
  const lines = [fish ? `fish_add_path ${q(binDir())}` : `export PATH=${q(binDir())}:"$PATH"`];
  if (aliases) lines.push('# 클진요: Claude Code를 기록기 경유로 실행 (uninstall 시 원래 별칭으로 돌아감)', ...aliasLines(text, fish));
  return `${START}\n${lines.join('\n')}\n${END}\n`;
};
const strip = text => text.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n');

export function installCommand({ node = process.execPath, entry, aliases = true }) {
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(shimPath(), `#!/bin/sh\nexec ${q(node)} ${q(entry)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(shimPath(), 0o755);
  const changed = [];
  for (const f of rcFiles()) {
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const next = strip(cur).replace(/\s*$/, '') + (cur.trim() ? '\n\n' : '') + block(f, cur, aliases);
    if (next !== cur) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, next); changed.push(f); }
  }
  const wrapped = aliases ? aliasLines(rcFiles().map(f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').join('\n')) : [];
  return { shim: shimPath(), rc: rcFiles(), changed, aliases: wrapped, onPath: (process.env.PATH || '').split(path.delimiter).includes(binDir()) };
}

export function uninstallCommand() {
  fs.rmSync(shimPath(), { force: true });
  for (const f of rcFiles()) {
    if (!fs.existsSync(f)) continue;
    const cur = fs.readFileSync(f, 'utf8');
    if (!cur.includes(START)) continue;
    const next = strip(cur).replace(/^\n+/, '').replace(/\n+$/, '\n');
    if (f.endsWith('jinsil.fish') && !next.trim()) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, next);
  }
}
