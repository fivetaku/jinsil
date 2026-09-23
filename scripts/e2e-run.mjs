#!/usr/bin/env node
// M4 로컬 E2E (실제 계정). 실제 Anthropic 구독을 소모한다 — 5시간 게이지 틱 4번(3%p 구간)이 생길 때까지만.
// 흐름: 로컬 서버(wrangler dev) → npm pack 한 CLI로 `npx <tgz> setup` → 기기 연결 승인(모의 IdP 세션) → 자동 제출 동의
//      → `jinsil claude -p`(실제 Claude Code, 기록기 경유) 반복 → 유휴 후 자동 제출 → 피드·/me 반영 → 거부 규칙 3종 → 개인정보 부재.
// 결과: docs/e2e-<날짜>.md (JSON 블록 포함). 인증값·응답 본문은 출력·저장하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, linkDevice, post } from '../server/test/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RUNS = Number(process.env.E2E_MAX_RUNS || 40);
const MARKER = `JINSIL_E2E_MARKER_${Date.now()}_본문저장금지`;
const log = m => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);
const result = { started_at: new Date().toISOString(), upstream: 'api.anthropic.com', model: 'claude-opus-5-5', runs: 0 };

// Claude Code를 이 세션의 하위로 오인하지 않도록 세션 관련 변수를 뺀 환경
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH)|CLAUDECODE)$/.test(k)));
const jinsilBin = () => path.join(os.homedir(), '.jinsil', 'app', JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'))).version, 'bin', 'jinsil.mjs');
const run = (args, opts = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [jinsilBin(), ...args], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  let out = '', err = '';
  c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; });
  if (opts.input !== undefined) c.stdin.end(opts.input); else c.stdin.end();
  c.on('exit', code => resolve({ code, out, err }));
});

// 입력 토큰을 쓰는 큰 문맥(저장소 문서·코드). 매 실행 앞에 nonce를 붙여 캐시 읽기로만 끝나지 않게.
function bigContext() {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory() && !['node_modules', '.git', '.wrangler', 'docs', '.e2e', '.fablize'].includes(e.name)) walk(p);
    else if (e.isFile() && /\.(mjs|js|md|sql)$/.test(e.name) && fs.statSync(p).size < 200000) files.push(p);
  } };
  walk(root);
  walk('/Users/chulrolee/ideation-workspace/50-blueprints/claude-quota-ledger/PRD');
  const text = files.map(f => `\n===== ${path.basename(f)} =====\n${fs.readFileSync(f, 'utf8')}`).join('');
  return text.length > 350000 ? text.slice(0, 350000) : text;
}

async function ledgerState() {
  const { readLedgerDir, computeIntervals } = await import(path.join(root, 'cli', 'src', 'interval.mjs'));
  const l = readLedgerDir(path.join(os.homedir(), '.jinsil', 'data'));
  const last = l.rows.filter(r => r.g['5h'] !== null).at(-1);
  return { rows: l.rows.length, last5h: last?.g['5h'] ?? null, last7d: last?.g['7d'] ?? null, fp: last?.fp || null,
    intervals: computeIntervals(l, { now: Date.now() + 11 * 60000 }).intervals };
}

const E2E_DIR = path.join(root, '.e2e');
fs.rmSync(E2E_DIR, { recursive: true, force: true });
fs.mkdirSync(E2E_DIR, { recursive: true });
const srv = await startServer({ MIN_ACCOUNTS: '5' }, { persist: path.join(E2E_DIR, 'd1') });
log(`server ${srv.base}`);
try {
  // 1) 패키징 → npx 설치·서비스 등록·기기 연결
  const tgz = execFileSync('npm', ['pack', '--pack-destination', E2E_DIR], { cwd: path.join(root, 'cli'), encoding: 'utf8' }).trim().split('\n').at(-1);
  const owner = await login(srv.base, 'e2e-owner');
  const setup = spawn('npx', ['--yes', `--package=${path.join(E2E_DIR, tgz)}`, 'jinsil', 'setup', '--server', srv.base], { env: { ...cleanEnv(), JINSIL_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let setupOut = '';
  const setupExit = new Promise(r => setup.on('exit', r));
  const approved = new Promise((resolve, reject) => {
    setup.stdout.on('data', async b => {
      setupOut += b;
      const m = /확인 코드: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(setupOut);
      if (m && !approved.done) {
        approved.done = true;
        const page = await (await fetch(`${srv.base}/link?code=${m[1]}`, { headers: { cookie: owner } })).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
        const r = await fetch(`${srv.base}/link`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, user_code: m[1], action: 'approve' }) });
        resolve(r.status);
      }
    });
    setup.on('exit', code => { if (code) reject(Error(`setup exit ${code}: ${setupOut}`)); });
  });
  result.link_approve_status = await approved;
  const setupCode = await setupExit;
  result.setup_exit = setupCode;
  log(`setup exit ${setupCode}, 연결 승인 HTTP ${result.link_approve_status}`);
  const auto = await run(['submit', '--auto', 'on', '--yes']);
  result.auto_submit = auto.out.trim();
  const health = await (await fetch('http://127.0.0.1:10199/_ledger/health')).json();
  result.recorder_health_before = health;

  // 2) 실제 Claude Code 반복 — 5시간 3%p 구간이 계산될 때까지
  const ctx = bigContext();
  result.context_chars = ctx.length;
  let st = await ledgerState();
  while (result.runs < MAX_RUNS && !st.intervals.some(i => i.gauge === '5h')) {
    const r = await run(['claude', '-p', `${MARKER}\n아래 자료의 핵심 설계 결정을 한 문장으로만 요약해.`, '--model', 'claude-opus-5-5'],
      { input: `nonce ${Date.now()}-${Math.random()}\n${ctx}` });
    result.runs++;
    st = await ledgerState();
    log(`run ${result.runs} exit ${r.code} · rows ${st.rows} · 5h ${st.last5h}% · 7d ${st.last7d}% · intervals ${st.intervals.length}`);
    if (r.code !== 0) { result.claude_error = (r.err || '').slice(0, 200).replace(/sk-ant-\S+/g, '[redacted]'); if (/limit|429/.test(r.err)) break; }
    if (st.last5h !== null && st.last5h >= 95) { result.stopped = 'five_hour_near_limit'; break; }
  }
  result.ledger = { rows: st.rows, last5h: st.last5h, last7d: st.last7d, intervals: st.intervals.map(i => ({ gauge: i.gauge, g: `${i.g_start}→${i.g_end}`, requests: i.requests, quality: i.quality })) };
  if (!st.intervals.length) throw Error('no_interval_formed');

  // 3) 자동 제출(기록기 유휴 60초 후) 대기 → 서버 반영
  let feed = [];
  const tag = st.fp.slice(-4);
  for (let i = 0; i < 60 && !feed.some(f => f.tag === tag); i++) {
    await new Promise(r => setTimeout(r, 5000));
    feed = await (await fetch(`${srv.base}/api/feed`)).json();
  }
  result.feed = feed.filter(f => f.tag === tag);
  result.auto_submitted = result.feed.length > 0;
  const submittedLog = fs.readFileSync(path.join(os.homedir(), '.jinsil', 'data', 'submitted.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  result.submitted = submittedLog.map(s => ({ http: s.http, status: s.status, reason: s.reason }));
  result.accepted = submittedLog.filter(s => s.status === 'accepted').length;
  const me = await (await fetch(`${srv.base}/me.json`, { headers: { cookie: owner } })).json();
  result.me = me.accounts.map(a => ({ tag: a.tag, plan: a.plan, eligible: a.eligible, ineligible: a.ineligible, weekly_pct: a.weekly_pct, rank: a.rank }));
  const home = await (await fetch(`${srv.base}/`)).text();
  result.home_shows_tag = home.includes(`#${tag}`);
  result.home_max5x_card = /Max 5x[\s\S]{0,400}?(측정 대기 · 참여 \d\/5|\d+배)/.exec(home)?.[1] || null;

  // 4) 거부 규칙 3종 — 실제 제출 구간을 바탕으로
  const { payloadOf } = await import(path.join(root, 'cli', 'src', 'submit.mjs'));
  const real = payloadOf(st.intervals.find(i => i.gauge === '5h'));
  const device = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.jinsil', 'device.json'), 'utf8'));
  const newId = n => real.interval_id.slice(0, -4) + n;
  const overlap = await post(srv.base, device.device_token, { ...real, interval_id: newId('0e01') });
  const intruder = await login(srv.base, 'e2e-intruder');
  const intruderToken = (await linkDevice(srv.base, intruder)).token.device_token;
  const stolen = await post(srv.base, intruderToken, { ...real, interval_id: newId('0e02'), g_start: real.g_start + 50, g_end: real.g_end + 50 });
  const lo = await run(['logout']);
  const revoked = await post(srv.base, device.device_token, { ...real, interval_id: newId('0e03'), g_start: real.g_start + 80, g_end: real.g_end + 80 });
  result.rejections = [
    { rule: 'overlapping_interval', http: overlap.status, reason: overlap.body?.reason },
    { rule: 'account_bound_to_other_user', http: stolen.status, reason: stolen.body?.reason },
    { rule: 'revoked_device', http: revoked.status, reason: revoked.body?.reason, logout: lo.out.trim() },
  ];

  // 5) 개인정보: 로컬 장부·서버 D1에 인증값·프롬프트 표식·응답 본문 없음
  const scan = dir => { let hits = []; const w = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
    if (e.isDirectory()) w(p); else if (e.isFile() && fs.statSync(p).size < 50e6) { const t = fs.readFileSync(p).toString('latin1');
      for (const pat of ['sk-ant-', 'Bearer ', MARKER.slice(0, 18), '@gmail.com', 'claudeAiOauth']) if (t.includes(pat)) hits.push(`${path.relative(dir, p)}:${pat}`); } } }; w(dir); return hits; };
  result.privacy_hits_local = scan(path.join(os.homedir(), '.jinsil', 'data'));
  result.privacy_hits_server_d1 = scan(path.join(E2E_DIR, 'd1'));
  result.recorder_health_after = await (await fetch('http://127.0.0.1:10199/_ledger/health')).json();
} catch (e) {
  result.error = /^[a-z_0-9 ]+$/i.test(e.message) ? e.message : String(e.message).slice(0, 300).replace(/sk-ant-\S+/g, '[redacted]');
} finally {
  // 사용자 환경 원복: 서비스 해제(기록은 ~/.jinsil/data에 보존), 서버 종료
  await run(['uninstall']);
  await srv.stop();
  result.finished_at = new Date().toISOString();
  const day = result.started_at.slice(0, 10);
  const file = path.join(root, 'docs', `e2e-${day}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# 로컬 E2E (실제 계정) — ${day}\n\n명령: \`node scripts/e2e-run.mjs\` · 확인: \`npm run e2e:check\`\n\n` +
    '- 실제 Anthropic 구독(키체인 로그인 계정, Claude Code 2.x)으로 `jinsil claude -p`를 기록기 경유 실행.\n' +
    '- 서버는 로컬 wrangler dev, 로그인은 모의 IdP(실제 Google 미검증). 배포·npm 게시 없음. 끝나면 서비스 해제.\n\n' +
    '```json\n' + JSON.stringify(result, null, 2) + '\n```\n');
  log(`결과: ${file}`);
}
