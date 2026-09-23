// 명령 라우터: setup · status · report · submit · login · logout · uninstall · collector · claude(호환)
// 0.2: 기본은 요청 경로 무개입 수집(대화 파일 + 게이지 샘플). --proxy는 다계정 풀 사용자용 로컬 기록기 모드.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { home, dataDir, appDir } from './paths.mjs';
import { loadConfig, saveConfig, loadDevice, saveDevice, removeDevice, ensureHome, DEFAULT_PORT } from './config.mjs';
import * as service from './service.mjs';
import * as shell from './shell.mjs';
import { submit, pendingPayloads, inputs, CLIENT_VERSION, CONSENT_VERSION } from './submit.mjs';
import { buildBins } from './bins.mjs';
import { sampleRows, heartbeat } from './collector.mjs';
import { computeWindows } from './window.mjs';
import { costOf, PRICES } from './prices.mjs';
import { planOf } from './tiers.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
// 월 구독료(USD, 미국 정가). 서버 plan_prices가 정본이며 여기 값은 로컬 표시용.
export const PLAN_PRICES = { pro: 20, max5x: 100, max20x: 200 };
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
async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const h = await check(); if (h) return h; await new Promise(r => setTimeout(r, 200)); }
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

function installId() {
  const c = loadConfig();
  if (c.install_id) return c.install_id;
  const id = randomUUID();
  saveConfig({ install_id: id });
  return id;
}

async function login(flags) {
  const cfg = loadConfig();
  const server = String(flags.server || cfg.server).replace(/\/$/, '');
  // 호스트명 대신 무작위 설치 식별자(같은 PC 재연결 판정용)를 보낸다.
  const r = await fetch(`${server}/device/code`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `pc-${installId()}`, os: `${process.platform}-${process.arch}`, client_version: CLIENT_VERSION }) })
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

export const CONSENT_TEXT = `── 클진요 0.2 수집 동의 ──
읽는 것 (이 PC 안에서만)
  · Claude Code 대화 파일(~/.claude/projects)의 사용량 숫자(usage)와 모델명·시각. 본문은 읽어도 저장하지 않습니다.
  · Claude Code 로그인 토큰(macOS 키체인, 그 외 ~/.claude/.credentials.json)으로 사용량 게이지(/api/oauth/usage)를 5분마다 조회(사용 중일 때만). 토큰은 api.anthropic.com에만 보냅니다.
서버로 보내는 것
  · 5분 단위 모델별 토큰 합계, 게이지 값(5시간·주간)과 리셋 시각, Claude 계정 지문(해시), 요금제 등급.
  · 5분 단위 시각이 서버에 저장됩니다(활동 시간대가 드러날 수 있음). 공개 증거 묶음은 창 기준 상대시간만 씁니다.
보내지 않는 것
  · 프롬프트·응답 본문, 파일 경로, 요청 ID, 호스트명, 이메일, 인증값.
끄기: jinsil submit --auto off · 지우기: jinsil uninstall --purge + 웹 /me에서 데이터 삭제`;

async function setup(flags) {
  ensureHome();
  const port = Number(flags.port || loadConfig().port || DEFAULT_PORT);
  const collector = flags.proxy ? 'proxy' : 'transcript';
  saveConfig({ port, collector, installed_at: loadConfig().installed_at || new Date().toISOString(),
    ...(flags.server ? { server: String(flags.server).replace(/\/$/, '') } : {}) });
  installId();
  // 동의 v2: 기존 0.1.x 동의는 재사용하지 않는다.
  const cfg0 = loadConfig();
  if (!flags['no-auto-submit'] && !(cfg0.consent_version === CONSENT_VERSION && cfg0.consent_v2_at)) {
    console.log(CONSENT_TEXT);
    const ok = flags.yes || await ask('\n이 범위로 수집·자동 제출하는 데 동의합니까? [y/N] ');
    if (ok) saveConfig({ consent_version: CONSENT_VERSION, consent_v2_at: new Date().toISOString(), auto_submit: true });
    else { saveConfig({ auto_submit: false }); console.log('동의하지 않아 자동 제출을 끕니다(로컬 기록만). 나중에 `jinsil setup`으로 다시 동의할 수 있습니다.'); }
  } else if (flags['no-auto-submit']) saveConfig({ auto_submit: false });
  const entry = copyRuntime();
  const svc = service.install({ entry, port });
  console.log(`런타임: ${path.dirname(path.dirname(entry))}\n서비스: ${svc.kind} (${svc.path}) · 모드: ${collector === 'proxy' ? '프록시(다계정 풀)' : '대화 파일 + 게이지(요청 경로 무개입)'}`);
  if (process.env.JINSIL_SERVICE_DRYRUN !== '1') {
    const ok = await waitFor(async () => { const hb = heartbeat(); return hb && Date.now() - hb.at < 30000 ? hb : null; }, 10000);
    if (!ok) throw Error('collector_start_failed');
    if (collector === 'proxy' && !(await waitFor(() => health(port)))) throw Error('recorder_start_failed');
    console.log('수집기 동작 확인');
  }
  let cmd = null;
  if (!flags['no-path']) {
    cmd = shell.installCommand({ entry });
    console.log(`명령 등록: ${cmd.shim}${cmd.changed.length ? ` (셸 설정: ${cmd.changed.join(', ')} — 이전 버전의 jinsil 별칭은 정리했습니다)` : ''}`);
  }
  if (!flags['no-login'] && !loadDevice()?.device_token) await login(flags);
  const cfg = loadConfig();
  console.log(`\n설치 끝. 자동 제출: ${cfg.auto_submit ? '켜짐' : '꺼짐'}.`);
  if (collector === 'proxy') console.log(`프록시 모드: 계정 풀(예: teamclaude)의 upstream을 http://127.0.0.1:${port} 로 직접 지정하세요. jinsil은 셸·풀 설정을 바꾸지 않습니다.`);
  else console.log('별도 명령 없이 평소처럼 Claude Code(터미널·IDE·SDK)를 쓰면 됩니다.');
  console.log('측정 주의: claude.ai 웹·앱이나 다른 PC 사용은 게이지만 올려 값이 낮게 잡힐 수 있습니다(해당 창은 "외부 사용 의심"으로 제외).');
  console.log('보낼 내용 미리보기: jinsil submit --dry-run · 상태: jinsil status · 내 결과: https://jinsil.axwith.com/me');
  return 0;
}

function status() {
  const cfg = loadConfig();
  const device = loadDevice();
  const hb = heartbeat();
  const alive = hb && Date.now() - hb.at < 3 * 60000;
  console.log(`수집기: ${alive ? `동작 중 (${hb.mode}${hb.gauge_status ? `, 게이지 ${hb.gauge_status}` : ''})` : '꺼짐'} · 서비스: ${service.installed() ? '등록됨' : '미등록'}`);
  console.log(`서버: ${device ? `연결됨 (${device.server})` : '미연결'} · 자동 제출: ${cfg.auto_submit ? '켜짐' : '꺼짐'} · 동의: ${cfg.consent_version === CONSENT_VERSION ? cfg.consent_v2_at : '0.2 동의 전'}`);
  if (hb?.messages !== undefined && hb?.messages !== null) console.log(`집계 메시지 ${hb.messages}개 · 제외 ${JSON.stringify(hb.excluded || {})}`);
  const { payloads, unverified } = pendingPayloads({ cfg });
  console.log(`보낼 묶음 ${payloads.length}개${unverified ? ` · 계정 미확정 bin ${unverified}` : ''}`);
  if (hb?.error) console.log(`마지막 오류: ${hb.error}`);
  return alive ? 0 : 2;
}

// 로컬 계산(서버와 같은 창 계산기). 단가는 잠정 로컬표.
export function localWindows(cfg = loadConfig()) {
  const { messages, samples } = inputs(cfg);
  const bins = buildBins(messages, samples);
  const byAcct = new Map();
  for (const s of samples) for (const r of sampleRows(s)) (byAcct.get(r.account_fp) || byAcct.set(r.account_fp, { samples: [], bins: [] }).get(r.account_fp)).samples.push(r);
  for (const b of bins) if (b.account_fp && byAcct.has(b.account_fp)) byAcct.get(b.account_fp).bins.push({ bin_start: b.bin_start,
    cost: costOf(b.model, b), unpriced: !Object.hasOwn(PRICES, b.model) || Object.keys(b.special).length > 0 });
  const out = [];
  for (const [fp, a] of byAcct) for (const w of computeWindows({ samples: a.samples, bins: a.bins })) out.push({ account_fp: fp, ...w });
  return out;
}

function report() {
  const ws = localWindows();
  if (!ws.length) { console.log('아직 한도 창이 없습니다. Claude Code를 쓰면 게이지 샘플과 사용량이 쌓입니다.'); return 0; }
  const STAGE = { precise: '정밀', normal: '보통', provisional: '잠정' };
  console.log('계정  게이지  창 리셋(UTC)       게이지      비용      1%당(범위)                 단계/상태');
  for (const w of ws) {
    const range = w.usd_per_pct === null ? '—' : `$${w.usd_per_pct.toFixed(2)} ($${(w.usd_per_pct_lo ?? 0).toFixed(2)}~${w.usd_per_pct_hi === null ? '?' : '$' + w.usd_per_pct_hi.toFixed(2)})`;
    console.log(`#${w.account_fp.slice(-4)}  ${w.gauge.padEnd(4)}  ${w.resets_at.slice(0, 16)}  ${`${w.g_base}→${w.g_end}%`.padEnd(10)}  ${w.cost === null ? '미확정' : '$' + w.cost.toFixed(2)}  ${range.padEnd(26)} ${w.exclude_reason ? `제외(${w.exclude_reason})` : `${STAGE[w.stage]}/${w.state === 'final' ? '확정' : '잠정'}`}`);
  }
  const weekly = ws.filter(w => w.gauge === '7d' && !w.exclude_reason && w.usd_per_pct !== null);
  const last = weekly.at(-1);
  if (last) {
    const plan = planOf(last.tier);
    const w100 = last.usd_per_pct * 100;
    console.log(`\n최근 주간 창 기준 100% 환산(잠정 API 정가): $${w100.toFixed(0)} · 근거 +${last.delta}%p`);
    if (plan && PLAN_PRICES[plan]) console.log(`30일 환산 가치 ≈ $${(w100 * WEEKS_PER_MONTH).toFixed(0)} · 구독료 $${PLAN_PRICES[plan]}의 ${(w100 * WEEKS_PER_MONTH / PLAN_PRICES[plan]).toFixed(1)}배`);
    console.log('매주 100%를 다 썼을 때의 이론적 상한이며, 단가는 잠정값입니다.');
  } else console.log('\n주간 100% 환산: 측정 대기 (주간 게이지 +5%p 이상 창 필요)');
  return 0;
}

// 호환: 0.1.x 별칭(alias claude='jinsil claude')이 남은 셸에서도 깨지지 않게.
// 프록시 모드면 기록기 경유, 아니면 claude를 그대로 실행한다.
async function claude(rest) {
  const cfg = loadConfig();
  const env = { ...process.env };
  if (cfg.collector === 'proxy') {
    if (!(await health(cfg.port))) throw Error('recorder_not_running');
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cfg.port}`;
  }
  const child = spawn(process.env.JINSIL_CLAUDE_BIN || 'claude', rest, { stdio: 'inherit', env });
  return await new Promise(resolve => {
    child.on('exit', code => resolve(code ?? 1));
    child.on('error', () => { console.error('[jinsil] claude 실행 파일을 찾지 못했습니다.'); resolve(127); });
  });
}

const HELP = `jinsil ${VERSION} — 클진요 (클로드에게 진실을 요구합니다)
  jinsil setup [--yes] [--proxy] [--server URL] [--no-login] [--no-path] [--no-auto-submit]
                                     수집기 설치·동의·서비스 등록·이 PC 연결 (--proxy: 다계정 풀용 로컬 기록기)
  jinsil status | report             상태 / 로컬 한도 창 계산
  jinsil submit [--dry-run] [--auto on|off]
  jinsil login | logout              웹 계정 연결 / 해제
  jinsil uninstall [--purge]         서비스 해제(--purge: 로컬 데이터 삭제)
원본 기록은 이 PC(~/.jinsil)에만 남고, 서버에는 5분 단위 토큰 합과 게이지만 갑니다.`;

export async function run(argv) {
  const [cmd, ...rest] = argv;
  const flags = flagsOf(rest);
  switch (cmd) {
    case 'recorder': { // 프록시 기록기만 단독 실행(진단·테스트용). 서비스는 collector가 모드에 따라 띄운다.
      const { startRecorder } = await import('./recorder.mjs');
      startRecorder({});
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
      return new Promise(() => {});
    }
    case 'collector': {
      const { startCollector } = await import('./collector.mjs');
      const onTick = async () => {
        const c = loadConfig();
        if (c.auto_submit && c.consent_version === CONSENT_VERSION && c.consent_v2_at && loadDevice()) await submit({ log: () => {} }).catch(() => {});
      };
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
      return startCollector({ onTick });
    }
    case 'setup': return setup(flags);
    case 'claude': return claude(rest);
    case 'status': return status();
    case 'report': return report();
    case 'submit': {
      if (flags.auto) {
        const on = flags.auto === 'on' || flags.auto === true;
        const c = loadConfig();
        if (on && !(c.consent_version === CONSENT_VERSION && c.consent_v2_at)) { console.log('0.2 수집 동의 전입니다. `jinsil setup`으로 동의하세요.'); return 1; }
        saveConfig({ auto_submit: on });
        console.log(`자동 제출: ${on ? '켜짐' : '꺼짐'}`);
        return 0;
      }
      await submit({ dryRun: Boolean(flags['dry-run']) });
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
