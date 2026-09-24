// 수집기 서비스(기본 모드): 1분마다 대화 파일 증분 읽기 → 게이지 샘플(5분) → 5분 bin → 자동 제출.
// 프록시 모드(config.collector === 'proxy')에서는 기록기(recorder.mjs)도 함께 띄우고, 장부 요청과 응답 헤더 게이지를 같은 형식으로 낸다.
// 로컬 상태: data/transcript_state.json, data/samples.jsonl, data/collector.json(하트비트). 본문·경로는 저장하지 않는다
// (transcript_state의 files 키는 이 PC의 파일 경로 — 서버로 가지 않음).
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';
import { loadConfig, loadDevice } from './config.mjs';
import { scan, lastActivity } from './transcript.mjs';
import { createSampler } from './gauge.mjs';
import { acquireLock, LEDGER_FILE } from './recorder.mjs';
import { readPool, scanPoolLog, createPoolSampler, lastActivityByFp } from './teamclaude.mjs';

const TICK_MS = 60000;
export const stateFile = () => path.join(dataDir(), 'transcript_state.json');
export const samplesFile = () => path.join(dataDir(), 'samples.jsonl');
export const heartbeatFile = () => path.join(dataDir(), 'collector.json');
export const poolStateFile = () => path.join(dataDir(), 'teamclaude_state.json');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJsonAtomic(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// 게이지 샘플 한 건 → 게이지별 행(창 계산기 입력 형식)
export function sampleRows(s) {
  const rows = [];
  for (const [gauge, b] of [['5h', s.five_hour], ['7d', s.seven_day]])
    if (b) rows.push({ observed_at: s.observed_at, account_fp: s.account_fp, tier: s.tier, gauge, utilization: b.utilization, resets_at: b.resets_at, source: s.source });
  return rows;
}
export function readSamples() {
  const f = samplesFile();
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function appendSample(s) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(samplesFile(), JSON.stringify(s) + '\n', { mode: 0o600 });
}

// 수집 1회(테스트에서 직접 호출). since = 동의 시각(소급 귀속 금지).
export async function collectOnce({ sampler, since, now = Date.now(), root } = {}) {
  const st = readJson(stateFile(), {});
  const changed = scan(st, { root, since, now });
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(stateFile(), st);
  const s = sampler ? await sampler.tick(lastActivity(st)) : null;
  if (s) appendSample(s);
  return { changed, sample: s, messages: Object.keys(st.messages).length, excluded: st.excluded };
}

// 계정 풀 모드 수집 1회: 풀 로그 증분 → 활동 계정 게이지 조회
export async function collectPoolOnce({ sampler, since, now = Date.now() } = {}) {
  const pool = readPool(undefined, loadConfig().pool_accounts);
  if (!pool) return { error: 'teamclaude_config_not_found' };
  const st = readJson(poolStateFile(), {});
  const changed = scanPoolLog(st, { pool, since, now });
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(poolStateFile(), st);
  const samples = sampler ? await sampler.tick(pool, lastActivityByFp(st)) : [];
  for (const s of samples) appendSample(s);
  return { changed, samples: samples.length, messages: Object.keys(st.messages).length, excluded: st.excluded };
}

// 자동 업데이트: 6시간마다 npm 최신 버전 확인, 더 새로우면 `npx jinsil@<v> setup --yes`로 스스로 교체한다(서비스 재등록·기록 재전송 포함).
// 끄기: setup --no-auto-update (config.auto_update=false). 목적지는 registry.npmjs.org 고정.
export const verLt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
async function latestVersion() {
  try { const r = await fetch('https://registry.npmjs.org/jinsil/latest', { signal: AbortSignal.timeout(15000) }); return r.ok ? (await r.json()).version : null; } catch { return null; }
}
export async function maybeSelfUpdate(current, { latest = latestVersion, spawnFn } = {}) {
  if (loadConfig().auto_update === false) return null;
  const v = await latest();
  if (!v || !/^\d+\.\d+\.\d+$/.test(v) || !verLt(current, v)) return null;
  const { spawn } = await import('node:child_process');
  const npx = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const log = fs.openSync(path.join(dataDir(), '..', 'update.log'), 'a');
  const child = (spawnFn || spawn)(fs.existsSync(npx) ? npx : 'npx', ['-y', `jinsil@${v}`, 'setup', '--yes', '--no-login', '--no-path'],
    { detached: true, stdio: ['ignore', log, log], shell: process.platform === 'win32', env: process.env });
  child.unref?.();
  return v;
}

export async function startCollector({ onTick, version } = {}) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const lockFd = acquireLock(path.join(dataDir(), 'collector.lock'));
  process.on('exit', () => { try { fs.closeSync(lockFd); fs.unlinkSync(path.join(dataDir(), 'collector.lock')); } catch {} });
  const cfg = loadConfig();
  if (cfg.collector === 'proxy') {
    const { startRecorder } = await import('./recorder.mjs');
    startRecorder({ port: cfg.port });
  }
  const pool = cfg.collector === 'teamclaude';
  const sampler = cfg.collector === 'proxy' ? null : pool ? createPoolSampler() : createSampler();
  const since = Date.parse(cfg.consent_v2_at || cfg.installed_at || 0) || 0;
  const loop = async () => {
    let r = null, err = null;
    try {
      r = cfg.collector === 'proxy' ? { proxy: true } : pool ? await collectPoolOnce({ sampler, since }) : await collectOnce({ sampler, since });
      if (r?.error) err = r.error;
      if (onTick) await onTick(r);
    } catch (e) { err = e.code || e.message; }
    writeJsonAtomic(heartbeatFile(), { pid: process.pid, at: Date.now(), mode: cfg.collector || 'transcript', gauge_status: pool ? [...(sampler.state.values?.() || [])].map(x => x.status).join(',') || null : sampler?.state.status ?? null,
      messages: r?.messages ?? null, excluded: r?.excluded ?? null, error: err, ledger: cfg.collector === 'proxy' ? LEDGER_FILE : null });
  };
  await loop();
  setInterval(loop, TICK_MS);
  if (version) { const check = () => maybeSelfUpdate(version).catch(() => null); setTimeout(check, 5 * 60000); setInterval(check, 6 * 3600000); }
  return new Promise(() => {});
}

export const heartbeat = () => readJson(heartbeatFile(), null);
export const deviceLinked = () => Boolean(loadDevice()?.device_token);
