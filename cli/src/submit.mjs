// 구간 제출. 첫 제출은 전송할 JSON을 보여 주고 동의를 받은 뒤에만 보낸다. 같은 interval_id 재전송은 서버가 멱등 처리.
import fs from 'node:fs';
import { dataDir, submitStateFile } from './paths.mjs';
import { readLedgerDir, computeIntervals } from './interval.mjs';
import { loadConfig, saveConfig, loadDevice } from './config.mjs';

export const CLIENT_VERSION = '0.1.0';

export function submittedIds() {
  const f = submitStateFile();
  const done = new Map();
  if (!fs.existsSync(f)) return done;
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); done.set(e.interval_id, e); } catch {}
  }
  return done;
}
const settled = e => e && (e.http === 200 || e.http === 201 || e.http === 409 || e.http === 422);

export function pendingIntervals({ now } = {}) {
  let ledger;
  try { ledger = readLedgerDir(dataDir()); } catch (e) { if (e.code === 'ENOENT') return { intervals: [], waiting: 0 }; throw e; }
  const { intervals, waiting } = computeIntervals(ledger, { now });
  const done = submittedIds();
  return { intervals: intervals.filter(i => !settled(done.get(i.interval_id))), waiting };
}

export const payloadOf = i => ({ ...i, client: { version: CLIENT_VERSION } });

export async function submit({ yes = false, dryRun = false, confirm = null, log = console.log, fetchImpl = fetch } = {}) {
  const cfg = loadConfig();
  const device = loadDevice();
  const { intervals, waiting } = pendingIntervals();
  if (!intervals.length) { log(`제출할 새 구간 없음${waiting ? ` (경계 요청 대기 ${waiting}건)` : ''}`); return { sent: 0, results: [] }; }
  if (dryRun || !cfg.consented_at) {
    log('── 서버로 보낼 내용 (구간 계산값만. 프롬프트·응답·인증값·이메일은 보내지 않음) ──');
    log(JSON.stringify(payloadOf(intervals[0]), null, 2));
    log(`총 ${intervals.length}개 구간`);
    if (dryRun) return { sent: 0, results: [], preview: intervals.length };
    const ok = yes || (confirm ? await confirm('이 형식으로 제출하는 데 동의합니까? [y/N] ') : false);
    if (!ok) { log('동의하지 않아 제출하지 않았습니다.'); return { sent: 0, results: [] }; }
    saveConfig({ consented_at: new Date().toISOString() });
  }
  if (!device?.device_token) throw Error('not_logged_in');
  const server = device.server || cfg.server;
  const results = [];
  for (const i of intervals) {
    let http = 0, body = null;
    try {
      const r = await fetchImpl(`${server}/v1/intervals`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${device.device_token}` },
        body: JSON.stringify(payloadOf(i)), signal: AbortSignal.timeout(15000) });
      http = r.status;
      try { body = await r.json(); } catch {}
    } catch { http = 0; }
    const rec = { interval_id: i.interval_id, http, status: body?.status || null, reason: body?.reason || null, at: Date.now() };
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(submitStateFile(), JSON.stringify(rec) + '\n', { mode: 0o600 });
    results.push(rec);
  }
  log(results.map(r => `${r.interval_id.slice(0, 8)} → HTTP ${r.http} ${r.status || ''}${r.reason ? ` (${r.reason})` : ''}`).join('\n'));
  return { sent: results.filter(r => settled(r)).length, results };
}
