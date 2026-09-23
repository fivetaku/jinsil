// 사용자 서비스 등록: macOS launchd(LaunchAgent), Linux systemd --user, Windows 로그인 시 자동 실행(HKCU Run, 관리자 권한 불필요).
// JINSIL_SERVICE_DRYRUN=1 이면 파일만 쓰고 launchctl/systemctl은 호출하지 않는다(테스트용).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { home } from './paths.mjs';

export const LABEL = 'com.axwith.jinsil';
const dry = () => process.env.JINSIL_SERVICE_DRYRUN === '1';
const agentsDir = () => process.env.JINSIL_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
const systemdDir = () => process.env.JINSIL_SYSTEMD_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
export const plistPath = () => path.join(agentsDir(), `${LABEL}.plist`);
export const unitPath = () => path.join(systemdDir(), 'jinsil.service');
// Windows: 콘솔 없이 수집기를 띄우고 죽으면 5초 뒤 다시 띄우는 PowerShell 감시 스크립트 + HKCU Run 등록.
const winDir = () => process.env.JINSIL_WIN_SERVICE_DIR || home();
export const winScriptPath = () => path.join(winDir(), 'jinsil-collector.ps1');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export function winScriptContent({ node, entry }) {
  const ps = s => `'${String(s).replace(/'/g, "''")}'`;
  return `# 클진요 수집기 감시(자동 생성). 수집기는 한 번에 하나만 뜬다(잠금 파일).
$env:JINSIL_HOME = ${ps(home())}
while ($true) {
  & ${ps(node)} ${ps(entry)} collector
  Start-Sleep -Seconds 5
}
`;
}
export const winRunCommand = () => `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${winScriptPath()}"`;

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function plistContent({ node, entry, port }) {
  const log = path.join(home(), 'collector.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(entry)}</string><string>collector</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JINSIL_HOME</key><string>${xml(home())}</string>
    <key>LEDGER_PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
export function unitContent({ node, entry, port }) {
  const q = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  return `[Unit]
Description=jinsil local usage collector (클진요)

[Service]
ExecStart=${q(node)} ${q(entry)} collector
Environment=JINSIL_HOME=${q(home())}
Environment=LEDGER_PORT=${port}
Restart=always

[Install]
WantedBy=default.target
`;
}

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function install({ node = process.execPath, entry, port }) {
  if (process.platform === 'darwin') {
    fs.mkdirSync(agentsDir(), { recursive: true });
    const p = plistPath();
    const target = `gui/${process.getuid()}/${LABEL}`;
    if (!dry()) { try { execFileSync('/bin/launchctl', ['bootout', target], { stdio: 'ignore' }); } catch {} }
    fs.writeFileSync(p, plistContent({ node, entry, port }), { mode: 0o644 });
    if (!dry()) {
      // bootout은 비동기로 끝난다. 이전 인스턴스가 사라지기 전에 bootstrap하면 실패(재실행 시 경합)하므로 기다렸다가 재시도한다.
      const loaded = () => { try { execFileSync('/bin/launchctl', ['print', target], { stdio: 'ignore' }); return true; } catch { return false; } };
      for (let i = 0; i < 50 && loaded(); i++) sleepMs(100);
      let last;
      for (let i = 0; i < 5; i++) {
        try { execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, p], { stdio: 'ignore' }); last = null; break; }
        catch (e) { last = e; if (loaded()) { last = null; break; } sleepMs(400); }
      }
      if (last) throw Error('launchd_bootstrap_failed');
    }
    return { kind: 'launchd', path: p };
  }
  if (process.platform === 'linux') {
    fs.mkdirSync(systemdDir(), { recursive: true });
    const p = unitPath();
    fs.writeFileSync(p, unitContent({ node, entry, port }), { mode: 0o644 });
    if (!dry()) {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'jinsil.service'], { stdio: 'ignore' });
    }
    return { kind: 'systemd', path: p };
  }
  if (process.platform === 'win32') {
    const p = winScriptPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, winScriptContent({ node, entry }));
    if (!dry()) {
      stopWindows();
      execFileSync('reg.exe', ['add', RUN_KEY, '/v', 'jinsil', '/t', 'REG_SZ', '/d', winRunCommand(), '/f'], { stdio: 'ignore' });
      const c = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', p], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
    }
    return { kind: 'windows-run', path: p };
  }
  throw Error('unsupported_platform');
}

// Windows: 감시 스크립트와 수집기 프로세스를 끝낸다(수집기 PID는 잠금 파일에 있음).
function stopWindows() {
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*jinsil-collector.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' }); } catch {}
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(home(), 'data', 'collector.lock'), 'utf8')).pid;
    if (Number.isInteger(pid)) process.kill(pid);
  } catch {}
}

export function uninstall() {
  if (process.platform === 'darwin') {
    if (!dry()) { try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch {} }
    fs.rmSync(plistPath(), { force: true });
    return { kind: 'launchd' };
  }
  if (process.platform === 'linux') {
    if (!dry()) { try { execFileSync('systemctl', ['--user', 'disable', '--now', 'jinsil.service'], { stdio: 'ignore' }); } catch {} }
    fs.rmSync(unitPath(), { force: true });
    return { kind: 'systemd' };
  }
  if (process.platform === 'win32') {
    if (!dry()) { stopWindows(); try { execFileSync('reg.exe', ['delete', RUN_KEY, '/v', 'jinsil', '/f'], { stdio: 'ignore' }); } catch {} }
    fs.rmSync(winScriptPath(), { force: true });
    return { kind: 'windows-run' };
  }
  return { kind: 'none' };
}

export function installed() {
  return process.platform === 'darwin' ? fs.existsSync(plistPath()) : process.platform === 'linux' ? fs.existsSync(unitPath())
    : process.platform === 'win32' ? fs.existsSync(winScriptPath()) : false;
}
