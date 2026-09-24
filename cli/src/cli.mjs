// 명령 라우터: setup · status · report · submit · login · logout · uninstall · collector · claude(호환)
// 0.2: 기본은 요청 경로 무개입 수집(대화 파일 + 게이지 샘플). --proxy는 다계정 풀 사용자용 로컬 기록기 모드.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { home, dataDir, appDir } from './paths.mjs';
import { loadConfig, saveConfig, loadDevice, saveDevice, removeDevice, ensureHome, DEFAULT_PORT } from './config.mjs';
import * as service from './service.mjs';
import * as shell from './shell.mjs';
import { submit, pendingPayloads, inputs, CLIENT_VERSION, CONSENT_VERSION } from './submit.mjs';
import { buildBins } from './bins.mjs';
import { sampleRows, heartbeat } from './collector.mjs';
import { computeWindows, CALC_VERSION, BIN_MS } from './window.mjs';
import { costOf, PRICES, PRICE_VERSION } from './prices.mjs';
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
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['server', 'port', 'auto', 'accounts'].includes(k)) out[k] = argv[++i];
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
  // 기기 이름 = 호스트명 · 설치 식별자 앞 8자리. 본인 /me에서 연결된 PC를 알아보는 용도(공개 화면 비노출), 같은 PC 재연결 판정에도 쓴다.
  const r = await fetch(`${server}/device/code`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${os.hostname().slice(0, 40)} · ${installId().slice(0, 8)}`, os: `${process.platform}-${process.arch}`, client_version: CLIENT_VERSION }) })
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
  · 프롬프트·응답 본문, 파일 경로, 요청 ID, 이메일, 인증값. (PC 이름(호스트명)은 기기 연결 때 한 번 보내며 본인 /me에서만 보입니다.)
자동 업데이트: 6시간마다 npm 최신 버전을 확인해 스스로 업데이트합니다(끄기: jinsil setup --no-auto-update).
끄기: jinsil submit --auto off · 지우기: jinsil uninstall --purge + 웹 /me에서 데이터 삭제`;

async function setup(flags) {
  ensureHome();
  const port = Number(flags.port || loadConfig().port || DEFAULT_PORT);
  // 모드는 명시할 때만 바꾼다: --proxy / --transcript. 재설치(npx jinsil@latest setup)가 기존 프록시 모드를 조용히 끄면
  // 풀(teamclaude)의 upstream이 닫힌 포트를 가리켜 요청이 끊긴다(09-24 실사고).
  const prev = loadConfig().collector;
  const collector = flags.teamclaude ? 'teamclaude' : flags.proxy ? 'proxy' : flags.transcript ? 'transcript' : ['proxy', 'teamclaude'].includes(prev) ? prev : 'transcript';
  if (prev === collector && prev !== 'transcript' && !flags[prev]) console.log(`기존 ${prev === 'proxy' ? '프록시' : '계정 풀(teamclaude)'} 모드를 유지합니다(바꾸려면 setup --transcript 등으로 지정).`);
  if (collector === 'teamclaude') {
    const { readPool, poolConfigPath, poolLogPath } = await import('./teamclaude.mjs');
    if (typeof flags.accounts === 'string') saveConfig({ pool_accounts: flags.accounts.split(',').map(x => x.trim()).filter(Boolean) });
    const p = readPool(undefined, loadConfig().pool_accounts);
    if (!p) throw Error(`teamclaude 설정을 읽지 못했습니다: ${poolConfigPath()}`);
    if (!p.size) throw Error('수집할 OAuth 계정이 없습니다(--accounts 이름 확인)');
    if (!fs.existsSync(poolLogPath())) throw Error(`teamclaude 사용 로그가 없습니다: ${poolLogPath()}`);
    console.log(`계정 풀 모드: teamclaude OAuth 계정 ${p.size}개, 로그 ${poolLogPath()} (풀 설정은 읽기만 합니다)`);
  }
  if (prev === 'proxy' && collector === 'transcript') console.log(`주의: 프록시 모드를 끕니다. http://127.0.0.1:${port}을 upstream으로 지정해 둔 도구가 있으면 원래 주소로 되돌리세요.`);
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
  // 계정 사용 범위(자기 신고): 웹·앱·다른 PC·봇에서 같은 계정을 쓰면 이 PC 기록만으로는 비용이 덜 잡힌다 → 통계에서 참고로만.
  if (flags.exclusive || flags.shared) saveConfig({ usage_scope: flags.shared ? 'shared' : 'exclusive' });
  else if (!flags.yes && !loadConfig().usage_scope && process.stdin.isTTY) {
    const shared = await ask('\n이 Claude 계정을 claude.ai 웹·앱, 다른 PC, 봇·스크립트에서도 같이 씁니까? [y/N] ');
    saveConfig({ usage_scope: shared ? 'shared' : 'exclusive' });
  }
  if (flags['no-auto-update']) saveConfig({ auto_update: false });
  // 버전이 바뀌면 이 PC에 남은 기록을 전부 다시 보낸다(서버 upsert, 새 기준으로 재계산).
  if (loadConfig().last_version !== VERSION) {
    try { fs.renameSync(path.join(dataDir(), 'v2_submitted.json'), path.join(dataDir(), `v2_submitted.${Date.now()}.bak`)); } catch {}
    saveConfig({ last_version: VERSION });
  }
  const entry = copyRuntime();
  const svc = service.install({ entry, port });
  console.log(`런타임: ${path.dirname(path.dirname(entry))}\n서비스: ${svc.kind} (${svc.path}) · 모드: ${{ proxy: '프록시(요청 경로 기록기)', teamclaude: '계정 풀 로그(teamclaude) + 계정별 게이지' }[collector] || '대화 파일 + 게이지(요청 경로 무개입)'}`);
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
  if (collector === 'transcript') console.log('별도 명령 없이 평소처럼 Claude Code(터미널·IDE·SDK)를 쓰면 됩니다.');
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
export function localWindows(cfg = loadConfig(), { raw = false } = {}) {
  const { messages, samples } = inputs(cfg);
  const bins = buildBins(messages, samples);
  const byAcct = new Map();
  for (const s of samples) for (const r of sampleRows(s)) (byAcct.get(r.account_fp) || byAcct.set(r.account_fp, { samples: [], bins: [] }).get(r.account_fp)).samples.push(r);
  for (const b of bins) if (b.account_fp && byAcct.has(b.account_fp)) byAcct.get(b.account_fp).bins.push({ bin_start: b.bin_start,
    cost: costOf(b.model, b), unpriced: !Object.hasOwn(PRICES, b.model) || Object.keys(b.special).length > 0 });
  const out = [];
  for (const [fp, a] of byAcct) for (const w of computeWindows({ samples: a.samples, bins: a.bins })) out.push({ account_fp: fp, ...w, ...(raw ? { _a: a } : {}) });
  return out;
}

// 증거 묶음(로컬, 01_PRD 3-6): 서버 /v2/evidence와 같은 형식. 시각은 창 기준점 대비 분, 지문은 끝 4자리 태그만.
export function evidenceBundle(cfg = loadConfig()) {
  const r6 = v => (v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6);
  const rel = (t, base) => Math.round((t - base) / 60000);
  const accts = new Map();
  for (const w of localWindows(cfg, { raw: true })) {
    const tag = w.account_fp.slice(-4);
    const samples = w._a.samples.filter(s => s.gauge === w.gauge && s.observed_at >= w.t_base && s.observed_at <= w.t_end).sort((x, y) => x.observed_at - y.observed_at);
    const perBin = new Map();
    for (const b of w._a.bins.filter(b => b.bin_start >= w.t_base - BIN_MS && b.bin_start <= w.t_end)) {
      const k = rel(b.bin_start, w.t_base), cur = perBin.get(k) ?? 0;
      perBin.set(k, cur === null || b.cost === null ? null : cur + b.cost);
    }
    (accts.get(tag) || accts.set(tag, { tag, windows: [] }).get(tag)).windows.push({ gauge: w.gauge, state: w.state, stage: w.stage, exclude_reason: w.exclude_reason,
      g_base: w.g_base, g_end: w.g_end, delta: w.delta, duration_min: rel(w.t_end, w.t_base), cost: r6(w.cost), cost_lo: r6(w.cost_lo), cost_hi: r6(w.cost_hi),
      usd_per_pct: r6(w.usd_per_pct), price_version: PRICE_VERSION, calc_version: w.calc_version,
      samples: samples.map(s => [rel(s.observed_at, w.t_base), s.utilization]), bins: [...perBin].sort((a, b) => a[0] - b[0]).map(([k, c]) => [k, r6(c)]) });
  }
  const body = { format: 'jinsil-evidence/1', scope: 'local', calc_version: CALC_VERSION,
    formula: 'account = ΣC/ΣΔ×100, range = ΣC⁻/Σ(Δ+1)×100 ~ ΣC⁺/Σ(Δ−1)×100, plan = median(account)',
    note: '이 PC가 로컬에서 관측한 값 · 시각은 창 기준점 대비 분 · 단가는 잠정 로컬표',
    price_tables: { [PRICE_VERSION]: Object.keys(PRICES).sort().map(m => [m, Object.keys(PRICES[m]).sort().map(c => [c, PRICES[m][c]])]) },
    accounts: [...accts.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1)) };
  const text = JSON.stringify(body);
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}

function report(flags = {}) {
  if (flags.evidence) {
    const { text, sha256 } = evidenceBundle();
    const f = path.join(dataDir(), `evidence-${sha256.slice(0, 12)}.json`);
    fs.writeFileSync(f, text + '\n', { mode: 0o600 });
    console.log(`증거 묶음: ${f}\nsha256: ${sha256}`);
    return 0;
  }
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
  jinsil setup [--exclusive|--shared] [--no-auto-update]  계정 전용·혼용 신고, 자동 업데이트 끄기
  jinsil status | report [--evidence] 상태 / 로컬 한도 창 계산(증거 묶음 파일)
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
      return startCollector({ onTick, version: VERSION });
    }
    case 'setup': return setup(flags);
    case 'claude': return claude(rest);
    case 'status': return status();
    case 'report': return report(flags);
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
