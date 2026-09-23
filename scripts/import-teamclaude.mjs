#!/usr/bin/env node
// teamclaude 요청 로그(~/Library/Logs/teamclaude-requests/*.log)를 jinsil 장부로 옮겨 구간 계산·제출한다.
// teamclaude는 계정 풀이지만 요청마다 실제 계정으로 api.anthropic.com에 직접 가므로, 계정별 게이지·토큰을 그대로 쓸 수 있다.
// 쓰는 값: 계정 이름→accountUuid(teamclaude 설정), 응답 헤더 게이지·리셋, 스트림 usage(5분/1시간 캐시 구분 포함).
// 쓰지 않는 값: 프롬프트·응답 본문·인증값·이메일·요청 ID — 장부에도 남기지 않는다.
// 요금제: 계정 토큰으로 /api/oauth/profile 조회(읽기 전용, 토큰은 메모리에서만). 조회 실패 계정은 요금제 미확인 → 통계 제외.
// 사용: node scripts/import-teamclaude.mjs [--dry-run] [--submit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HOME = process.env.JINSIL_IMPORT_HOME || path.join(os.homedir(), '.jinsil-import-teamclaude');
const LOG_DIR = process.env.TC_LOG_DIR || path.join(os.homedir(), 'Library', 'Logs', 'teamclaude-requests');
const CONFIG = process.env.TEAMCLAUDE_CONFIG || path.join(os.homedir(), '.config', 'teamclaude.json');
const args = new Set(process.argv.slice(2));
process.env.JINSIL_HOME = HOME;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { COLUMNS, accountFingerprint } = await import(path.join(root, 'cli/src/recorder.mjs'));
const { readLedgerDir, computeIntervals } = await import(path.join(root, 'cli/src/interval.mjs'));

// 1) 계정: 이름 → uuid, 토큰(메모리)
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const accounts = new Map();
for (const a of cfg.accounts || []) if (a.type === 'oauth' && a.accountUuid) accounts.set(a.name, { uuid: a.accountUuid, token: a.accessToken });

// 2) 요금제: 프로필 조회 (계정당 1회)
async function tierOf(token) {
  if (!token) return null;
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/profile', { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.organization?.rate_limit_tier === 'string' ? j.organization.rate_limit_tier : null;
  } catch { return null; }
}

// 3) 로그 파싱
function localMs(name) { // 20260923_213933.840_01800.log (로컬 시각)
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(\d{3})_/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() : null;
}
function parseLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  const acct = /^=== REQUEST \(account: ([^,]+), retry: \d+\) ===/.exec(text)?.[1];
  const status = Number(/=== RESPONSE (\d{3}) ===/.exec(text)?.[1] || 0);
  if (!acct || status !== 200) return null;
  const respHead = text.slice(text.indexOf('=== RESPONSE '), text.indexOf('=== RESPONSE BODY'));
  const h = k => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'mi').exec(respHead)?.[1]?.trim() ?? '';
  let model = '', usage = null, output = null, complete = false;
  const streamed = text.includes('=== RESPONSE BODY (streamed) ===');
  if (streamed) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
      if (e.type === 'message_start') { model = e.message?.model || ''; usage = e.message?.usage || null; }
      else if (e.type === 'message_delta' && Number.isInteger(e.usage?.output_tokens)) output = e.usage.output_tokens;
      else if (e.type === 'message_stop') complete = true;
    }
  } else {
    try { const j = JSON.parse(text.slice(text.indexOf('{', text.indexOf('=== RESPONSE BODY')))); model = j.model || ''; usage = j.usage || null; output = j.usage?.output_tokens ?? null; complete = !!usage; } catch {}
  }
  if (!usage || output === null) return null;
  const cc = usage.cache_creation;
  const w5 = cc ? cc.ephemeral_5m_input_tokens ?? 0 : 0, w1 = cc ? cc.ephemeral_1h_input_tokens ?? 0 : 0;
  const wUnknown = cc ? 0 : (usage.cache_creation_input_tokens ?? 0);
  const started = localMs(path.basename(file));
  const ended = Math.round(fs.statSync(file).mtimeMs);
  const dateMs = Date.parse(h('date'));
  return {
    acct, row: {
      ts_ms: Math.min(ended, Math.max(started, Number.isFinite(dateMs) ? dateMs : started)), model,
      input: usage.input_tokens ?? 0, output, cache_write_5m: w5, cache_write_1h: w1, cache_read: usage.cache_read_input_tokens ?? 0,
      u5h: h('anthropic-ratelimit-unified-5h-utilization'), u7d: h('anthropic-ratelimit-unified-7d-utilization'), u7d_oi: '',
      reset_5h: h('anthropic-ratelimit-unified-5h-reset'), reset_7d: h('anthropic-ratelimit-unified-7d-reset'),
      unified_status: h('anthropic-ratelimit-unified-status'), http_status: 200, stream: streamed ? 1 : 0, request_id: '',
      schema_version: 3, local_request_id: 'tc-' + createHash('sha256').update(path.basename(file)).digest('hex').slice(0, 24), message_id: '',
      started_ms: started, ended_ms: ended, cache_write_unknown: wUnknown, complete: complete ? 1 : 0,
      quality: complete ? 'complete' : 'stream_incomplete', usage_observed: 1,
    },
  };
}

const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).sort().map(f => path.join(LOG_DIR, f));
const parsed = files.map(parseLog).filter(Boolean);
const tiers = new Map();
for (const name of new Set(parsed.map(p => p.acct))) if (accounts.has(name)) tiers.set(name, await tierOf(accounts.get(name).token));
const rows = [];
const perAcct = new Map();
for (const p of parsed) {
  const a = accounts.get(p.acct);
  if (!a) continue; // 설정에서 지워진 계정: uuid를 알 수 없어 제외
  const fp = accountFingerprint(a.uuid);
  rows.push({ ...p.row, account_fp: fp, tier: tiers.get(p.acct) || '' });
  const s = perAcct.get(fp) || { tier: tiers.get(p.acct) || '(미확인)', rows: 0 };
  s.rows++; perAcct.set(fp, s);
}
rows.sort((a, b) => a.ts_ms - b.ts_ms);

// 4) 전용 장부에 쓰기(매번 전체 재생성 — 결정적 interval_id라 재실행해도 서버 제출은 멱등)
const dataDir = path.join(HOME, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const clean = v => String(v ?? '').replace(/[\t\n\r]/g, ' ');
fs.writeFileSync(path.join(dataDir, 'usage.tsv'), COLUMNS.join('\t') + '\n' + rows.map(r => COLUMNS.map(c => clean(r[c])).join('\t')).join('\n') + '\n', { mode: 0o600 });

fs.writeFileSync(path.join(dataDir, 'lifecycle.jsonl'), rows.flatMap(r => [
  JSON.stringify({ type: 'start', local_request_id: r.local_request_id, at_ms: r.started_ms }),
  JSON.stringify({ type: 'end', local_request_id: r.local_request_id, at_ms: r.ended_ms })]).join('\n') + '\n', { mode: 0o600 });

const { intervals, waiting } = computeIntervals(readLedgerDir(dataDir), { now: Date.now() });

// 5) 완전성 검증: teamclaude-usage.tsv(모든 요청을 입력·출력 줄로 기록)와 대조해,
//    구간 안의 모든 요청이 요청 로그에도 있는 구간만 제출한다(요청 로그는 일부 요청을 남기지 않음 — 토큰 과소 집계 방지).
const USAGE_TSV = process.env.TC_USAGE_TSV || path.join(os.homedir(), 'Library', 'Logs', 'teamclaude-usage.tsv');
const fpByName = new Map([...accounts].map(([n, a]) => [n, accountFingerprint(a.uuid)]));
const tsvTimes = new Map();
for (const line of fs.readFileSync(USAGE_TSV, 'utf8').split('\n')) {
  const c = line.split('\t'); const fp = fpByName.get(c[1]);
  if (fp) (tsvTimes.get(fp) || tsvTimes.set(fp, []).get(fp)).push(Number(c[0]));
}
const spans = new Map();
for (const r of rows) (spans.get(r.account_fp) || spans.set(r.account_fp, []).get(r.account_fp)).push([r.started_ms, r.ended_ms]);
const covered = i => {
  const a = Date.parse(i.t_start), b = Date.parse(i.t_end) + 60000; // 분 단위 표기 → 넓게 검사
  const ts = (tsvTimes.get(i.account_fp) || []).filter(t => t > a && t <= b);
  const sp = spans.get(i.account_fp) || [];
  return ts.length > 0 && ts.every(t => sp.some(([s0, e0]) => t >= s0 - 2000 && t <= e0 + 2000));
};
const verified = intervals.filter(i => covered(i) && i.tier);
console.log(`로그 ${files.length}개 · 200 응답 usage ${parsed.length}건 · 장부 ${rows.length}행 · 계정 ${perAcct.size}개`);
for (const [fp, s] of perAcct) {
  const iv = intervals.filter(i => i.account_fp === fp);
  console.log(`  #${fp.slice(-4)} ${s.tier} · ${s.rows}행 · 구간 5h ${iv.filter(i => i.gauge === '5h').length} / 주간 ${iv.filter(i => i.gauge === '7d').length}`);
}
console.log(`구간 ${intervals.length}개 (경계 대기 ${waiting})`);
const q = {};
for (const i of intervals) for (const f of i.quality || []) q[f] = (q[f] || 0) + 1;
if (Object.keys(q).length) console.log('품질 플래그:', q);
console.log(`완전성 검증 통과 + 요금제 확인: ${verified.length}개 구간만 제출 대상`);
// 제출 대상만 남기도록 장부 경로를 쓰는 submit 대신, 같은 형식으로 직접 제출한다.

if (args.has('--submit') || args.has('--dry-run')) {
  // 제출은 이 PC의 기기 연결을 그대로 쓴다(서버 사용자 = 이 PC 소유자).
  for (const f of ['device.json', 'config.json']) {
    const src = path.join(os.homedir(), '.jinsil', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HOME, f));
  }
  fs.chmodSync(path.join(HOME, 'device.json'), 0o600);
  const { payloadOf, submittedIds } = await import(path.join(root, 'cli/src/submit.mjs'));
  const device = JSON.parse(fs.readFileSync(path.join(HOME, 'device.json'), 'utf8'));
  const done = submittedIds();
  const todo = verified.filter(i => ![200, 201, 409, 422].includes(done.get(i.interval_id)?.http));
  if (args.has('--dry-run')) { console.log(JSON.stringify(payloadOf(todo[0]), null, 2)); console.log(`제출 예정 ${todo.length}개`); process.exit(0); }
  const tally = {};
  for (const i of todo) {
    const r = await fetch(`${device.server}/v1/intervals`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.device_token}` }, body: JSON.stringify(payloadOf(i)) });
    let body = null; try { body = await r.json(); } catch {}
    fs.appendFileSync(path.join(dataDir, 'submitted.jsonl'), JSON.stringify({ interval_id: i.interval_id, http: r.status, status: body?.status || null, reason: body?.reason || null, at: Date.now() }) + '\n', { mode: 0o600 });
    const k = `${r.status} ${body?.status || ''}${body?.reason ? ' ' + body.reason : ''}`; tally[k] = (tally[k] || 0) + 1;
  }
  console.log('제출 결과:', tally);
}
