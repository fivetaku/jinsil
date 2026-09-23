// 명령 라우터: setup · claude · status · report · submit · login · logout · uninstall · recorder
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { home, dataDir, appDir } from './paths.mjs';
import { loadConfig, saveConfig, loadDevice, saveDevice, removeDevice, ensureHome, DEFAULT_PORT } from './config.mjs';
import * as service from './service.mjs';
import * as shell from './shell.mjs';
import { submit, pendingIntervals, CLIENT_VERSION } from './submit.mjs';
import { readLedgerDir, computeIntervals, localCost } from './interval.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
// 월 구독료(USD, 미국 정가). 서버 plan_prices가 정본이며 여기 값은 로컬 표시용.
export const PLAN_PRICES = { pro: 20, max5x: 100, max20x: 200 };
export const planOf = tier => !tier ? null : /max_20x/.test(tier) ? 'max20x' : /max_5x/.test(tier) ? 'max5x' : /pro/.test(tier) ? 'pro' : null;
export const WEEKS_PER_MONTH = 30 / 7;

function flagsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['server', 'port', 'auto'].includes(k)) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_ledger/health`, { signal: AbortSignal.timeout(2000) });
    return { status: r.status, ...(await r.json()) };
  } catch { return null; }
}
async function waitHealth(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const h = await health(port); if (h) return h; await new Promise(r => setTimeout(r, 200)); }
  return null;
}
const ask = async q => {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
};

function copyRuntime() {
  const dest = appDir(VERSION);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const part of ['bin', 'src', 'package.json']) fs.cpSync(path.join(pkgRoot, part), path.join(dest, part), { recursive: true });
  return path.join(dest, 'bin', 'jinsil.mjs');
}

async function login(flags) {
  const cfg = loadConfig();
  const server = String(flags.server || cfg.server).replace(/\/$/, '');
  const r = await fetch(`${server}/device/code`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: os.hostname(), os: `${process.platform}-${process.arch}`, client_version: CLIENT_VERSION }) })
    .catch(() => { throw Error('server_unreachable'); });
  if (!r.ok) throw Error(`device_code_http_${r.status}`);
  const d = await r.json();
  console.log(`브라우저에서 이 PC 연결을 승인하세요: ${d.verify_url}\n확인 코드: ${d.user_code}`);
  if (!process.env.JINSIL_NO_BROWSER) {
    try { execFileSync(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [d.verify_url], { stdio: 'ignore' }); } catch {}
  }
  const deadline = Date.now() + (d.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, (d.interval || 5) * 1000));
    const t = await fetch(`${server}/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: d.device_code }) });
    if (t.status === 200) {
      const tok = await t.json();
      saveDevice({ server, device_id: tok.device_id, device_token: tok.device_token, linked_at: new Date().toISOString() });
      saveConfig({ server });
      console.log('이 PC가 연결됐습니다.');
      return 0;
    }
    if (t.status === 428) continue;
    throw Error(t.status === 403 ? 'device_denied' : t.status === 410 ? 'device_code_expired' : `device_token_http_${t.status}`);
  }
  throw Error('device_code_expired');
}

function report() {
  let ledger;
  try { ledger = readLedgerDir(dataDir()); } catch { console.log('기록이 아직 없습니다. `jinsil claude`로 Claude Code를 사용하세요.'); return 0; }
  const { intervals, waiting } = computeIntervals(ledger);
  console.log(`요청 ${ledger.rows.length}건 기록 · 구간 ${intervals.length}개${waiting ? ` · 경계 대기 ${waiting}` : ''}`);
  console.log('게이지  구간          요청   잠정비용    1%당      품질');
  for (const i of intervals) {
    const c = localCost(i.tokens_by_model);
    const span = i.g_end - i.g_start;
    console.log(`${i.gauge.padEnd(6)}  ${`${i.g_start}%→${i.g_end}%`.padEnd(12)}  ${String(i.requests).padStart(5)}  ${c === null ? '   미확정' : ('$' + c.toFixed(2)).padStart(9)}  ${c === null ? '  미확정' : ('$' + (c / span).toFixed(2)).padStart(8)}  ${i.quality.join(',') || '정상'}`);
  }
  const weekly = intervals.filter(i => i.gauge === '7d' && !i.quality.length);
  const cost = weekly.map(i => localCost(i.tokens_by_model));
  const pct = weekly.reduce((s, i) => s + i.g_end - i.g_start, 0);
  if (weekly.length && cost.every(c => c !== null) && pct > 0) {
    const w100 = cost.reduce((a, b) => a + b, 0) / pct * 100;
    const plan = planOf(weekly.at(-1).tier);
    console.log(`\n주간 100% 환산(잠정 API 정가): $${w100.toFixed(0)} · 근거 주간 ${pct}%p`);
    if (plan) {
      const monthly = w100 * WEEKS_PER_MONTH;
      console.log(`월 최대 가치 ≈ $${monthly.toFixed(0)} · 구독료 $${PLAN_PRICES[plan]}의 ${(monthly / PLAN_PRICES[plan]).toFixed(1)}배 · API 1달러를 ${(PLAN_PRICES[plan] / monthly * 100).toFixed(2)}센트에 사용`);
    }
    console.log('매주 100%를 다 썼을 때의 이론적 상한이며, 단가는 잠정값입니다.');
  } else console.log('\n주간 100% 환산: 측정 대기 (정상 주간 구간 부족)');
  return 0;
}

async function status() {
  const cfg = loadConfig();
  const h = await health(cfg.port);
  const device = loadDevice();
  console.log(`기록기: ${h ? `동작 중 (진행 ${h.active_requests}, 쓰기 실패 ${h.write_failures})` : '꺼짐'} · 포트 ${cfg.port}`);
  console.log(`서비스: ${service.installed() ? '등록됨' : '미등록'} · 서버: ${device ? `연결됨 (${device.server})` : '미연결'} · 자동 제출: ${cfg.auto_submit ? '켜짐' : '꺼짐'}`);
  try {
    const ledger = readLedgerDir(dataDir());
    const last = ledger.rows.filter(r => r.g['5h'] !== null).at(-1);
    console.log(`기록 ${ledger.rows.length}건${last ? ` · 최근 게이지 5시간 ${last.g['5h']}% / 주간 ${last.g['7d'] ?? '?'}%` : ''}`);
    const { intervals, waiting } = pendingIntervals();
    console.log(`미제출 구간 ${intervals.length}개${waiting ? ` · 경계 대기 ${waiting}` : ''}`);
  } catch { console.log('기록 없음'); }
  return h && h.write_failures ? 2 : 0;
}

async function claude(flags, rest) {
  const cfg = loadConfig();
  const h = await health(cfg.port);
  if (!h) throw Error('recorder_not_running');
  const env = { ...process.env };
  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_BASE_URL.includes(`127.0.0.1:${cfg.port}`))
    console.error('[jinsil] 기존 ANTHROPIC_BASE_URL(라우터 등)은 이 실행에서만 기록기로 바뀝니다. 계정 풀·라우터 경유 사용은 통계에서 제외됩니다.');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[k];
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cfg.port}`;
  const bin = process.env.JINSIL_CLAUDE_BIN || 'claude';
  const child = spawn(bin, rest, { stdio: 'inherit', env });
  return await new Promise(resolve => {
    child.on('exit', code => resolve(code ?? 1));
    child.on('error', () => { console.error('[jinsil] claude 실행 파일을 찾지 못했습니다.'); resolve(127); });
  });
}

const HELP = `jinsil ${VERSION} — 클진요 (클로드에게 진실을 요구합니다)
  jinsil setup [--server URL] [--no-login] [--no-path] [--no-alias] [--no-auto-submit]
                                                         기록기 설치·서비스 등록·이 PC 연결
  jinsil claude [claude 인수...]                         기록기를 거쳐 Claude Code 실행
  jinsil status | report                                 상태 / 로컬 계산 결과
  jinsil submit [--yes] [--dry-run] [--auto on|off]      구간 제출(첫 회는 미리보기·동의)
  jinsil login | logout                                  웹 계정 연결 / 해제
  jinsil uninstall [--purge]                             서비스 해제(--purge: 로컬 데이터 삭제)
원본 기록은 이 PC(~/.jinsil)에만 남고, 서버에는 구간 계산값만 갑니다.`;

export async function run(argv) {
  const [cmd, ...rest] = argv;
  const flags = flagsOf(rest);
  switch (cmd) {
    case 'recorder': {
      const { startRecorder } = await import('./recorder.mjs');
      const onIdle = async () => {
        const c = loadConfig();
        if (c.auto_submit && c.consented_at && loadDevice()) await submit({ log: () => {} }).catch(() => {});
      };
      startRecorder({ onIdle });
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
      return new Promise(() => {});
    }
    case 'setup': {
      ensureHome();
      const port = Number(flags.port || loadConfig().port || DEFAULT_PORT);
      saveConfig({ port, ...(flags.server ? { server: String(flags.server).replace(/\/$/, '') } : {}) });
      const entry = copyRuntime();
      const svc = service.install({ entry, port });
      console.log(`기록기 런타임: ${path.dirname(path.dirname(entry))}\n서비스: ${svc.kind} (${svc.path})`);
      if (process.env.JINSIL_SERVICE_DRYRUN !== '1') {
        const h = await waitHealth(port);
        if (!h) throw Error('recorder_start_failed');
        console.log(`기록기 동작 확인: 127.0.0.1:${port}`);
      }
      let cmd = null;
      if (!flags['no-path']) {
        cmd = shell.installCommand({ entry, aliases: !flags['no-alias'] });
        console.log(`명령 등록: ${cmd.shim}${cmd.changed.length ? ` (셸 설정: ${cmd.changed.join(', ')})` : ''}`);
        if (cmd.aliases.length) console.log(`기록기 경유 별칭: ${cmd.aliases.map(a => a.replace(/^alias\s+/, '').replace(/=.*$/, '')).join(', ')} (끄기: jinsil setup --no-alias)`);
      }
      if (!flags['no-auto-submit']) {
        const cfg0 = loadConfig();
        saveConfig({ auto_submit: true, ...(cfg0.consented_at ? {} : { consented_at: new Date().toISOString() }) });
        console.log('자동 제출: 켜짐 — 서버에는 구간 계산값(게이지 변화·토큰 합계·요금제)만 갑니다. 프롬프트·응답·인증값·이메일은 보내지 않습니다. (끄기: jinsil submit --auto off)');
      }
      if (!flags['no-login']) await login(flags);
      if (cmd && !cmd.onPath) console.log(`새 터미널을 열면 \`jinsil claude\`를 쓸 수 있습니다. 이 터미널에서는 \`source ${cmd.rc[0]}\` 후 사용하세요.`);
      else console.log('이제 `jinsil claude`로 Claude Code를 사용하세요.');
      return 0;
    }
    case 'claude': return claude(flags, rest);
    case 'status': return status();
    case 'report': return report();
    case 'submit': {
      if (flags.auto) {
        const on = flags.auto === 'on' || flags.auto === true;
        // --yes와 함께 켜면 그 자체를 제출 동의로 기록한다(형식은 --dry-run으로 미리 볼 수 있음).
        saveConfig({ auto_submit: on, ...(on && flags.yes && !loadConfig().consented_at ? { consented_at: new Date().toISOString() } : {}) });
        console.log(`자동 제출: ${on ? '켜짐' : '꺼짐'}${on && !loadConfig().consented_at ? ' (첫 제출 동의 전이라 대기 — jinsil submit으로 동의)' : ''}`);
        if (!flags.yes && !flags['dry-run']) return 0;
      }
      await submit({ yes: Boolean(flags.yes), dryRun: Boolean(flags['dry-run']), confirm: ask });
      return 0;
    }
    case 'login': return login(flags);
    case 'logout': {
      const d = loadDevice();
      if (d) { try { await fetch(`${d.server}/device/revoke`, { method: 'POST', headers: { authorization: `Bearer ${d.device_token}` } }); } catch {} }
      removeDevice();
      console.log('이 PC 연결을 해제했습니다.');
      return 0;
    }
    case 'uninstall': {
      service.uninstall();
      shell.uninstallCommand();
      fs.rmSync(path.join(home(), 'app'), { recursive: true, force: true });
      if (flags.purge) {
        const d = loadDevice();
        if (d) { try { await fetch(`${d.server}/device/revoke`, { method: 'POST', headers: { authorization: `Bearer ${d.device_token}` } }); } catch {} }
        fs.rmSync(home(), { recursive: true, force: true });
      }
      console.log(`서비스를 해제했습니다${flags.purge ? '. 로컬 기록도 삭제했습니다' : `. 기록은 ${dataDir()}에 남아 있습니다`}.`);
      return 0;
    }
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
    case '--version': case 'version': console.log(VERSION); return 0;
    default: console.log(HELP); return 1;
  }
}
