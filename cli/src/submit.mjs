// v2 제출: 계정별로 5분 bin(토큰 합)과 게이지 샘플을 보낸다. 창 계산은 서버가 한다(window.mjs 공용).
// - 동의 v2(consent_v2_at) 없이는 보내지 않는다. 기존 0.1.x 동의는 재사용하지 않는다.
// - 같은 bin 키의 내용(hash)이 바뀌면 다시 보낸다(서버 upsert). 샘플은 계정별 마지막으로 보낸 시각 이후만.
// - 계정을 확정하지 못한 bin(attribution_unverified)은 보내지 않고 개수만 알린다.
// 보내지 않는 것: 본문·파일 경로·요청 ID·메시지 ID·호스트명·이메일·인증값.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';
import { loadConfig, loadDevice } from './config.mjs';
import { buildBins } from './bins.mjs';
import { readSamples, sampleRows, stateFile, poolStateFile } from './collector.mjs';
import { COLUMNS, LEDGER_FILE } from './recorder.mjs';
import { PRICES, TOKEN_KEYS } from './prices.mjs';

export const CLIENT_VERSION = '0.2.2';
export const CONSENT_VERSION = 2;
const MAX_BINS = 200, MAX_SAMPLES = 400;
const sentFile = () => path.join(dataDir(), 'v2_submitted.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// 프록시 모드 장부(usage.tsv) → 메시지·샘플(계정은 요청마다 확정)
export function proxyInputs(dir = dataDir()) {
  const f = path.join(dir, LEDGER_FILE);
  const messages = {}, samples = [];
  if (!fs.existsSync(f)) return { messages, samples };
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const head = lines.shift()?.split('\t') || COLUMNS;
  for (const line of lines) {
    const c = Object.fromEntries(line.split('\t').map((v, i) => [head[i], v]));
    if (!c.account_fp) continue;
    const ts = Number(c.ended_ms || c.ts_ms), t0 = Number(c.ts_ms);
    const pct = v => (v === '' || v === undefined ? null : Math.round(Number(v) * 10000) / 100);
    const iso = v => (v ? new Date(Number(v) * 1000).toISOString() : null);
    const u5 = pct(c.u5h), u7 = pct(c.u7d);
    if (u5 !== null || u7 !== null) samples.push({ observed_at: t0, account_fp: c.account_fp, tier: c.tier || null, source: 'header',
      five_hour: u5 !== null && c.reset_5h ? { utilization: u5, resets_at: iso(c.reset_5h) } : null,
      seven_day: u7 !== null && c.reset_7d ? { utilization: u7, resets_at: iso(c.reset_7d) } : null });
    if (c.http_status !== '200' || c.complete !== '1' || !Object.hasOwn(PRICES, c.model)) continue;
    messages[c.local_request_id] = { key: c.local_request_id, ts, model: c.model, account_fp: c.account_fp, tier: c.tier || null,
      tokens: Object.fromEntries(TOKEN_KEYS.map(k => [k, Number(c[k]) || 0])), special: {}, sidechain: false };
  }
  return { messages, samples };
}

export function inputs(cfg = loadConfig()) {
  if (cfg.collector === 'proxy') return proxyInputs();
  if (cfg.collector === 'teamclaude') return { messages: readJson(poolStateFile(), {}).messages || {}, samples: readSamples() };
  return { messages: readJson(stateFile(), {}).messages || {}, samples: readSamples() };
}

const binOut = b => ({ bin_start: b.bin_start, model: b.model, ...Object.fromEntries(TOKEN_KEYS.map(k => [k, b[k]])),
  messages: b.messages, sidechain_messages: b.sidechain_messages, special: b.special, revision: b.hash });

// 계정별 보낼 payload 목록
export function pendingPayloads({ cfg = loadConfig() } = {}) {
  const { messages, samples } = inputs(cfg);
  const bins = buildBins(messages, samples);
  const sent = readJson(sentFile(), { bins: {}, samples: {} });
  const unverified = bins.filter(b => !b.account_fp).length;
  const accounts = new Map();
  const acc = fp => accounts.get(fp) || accounts.set(fp, { bins: [], samples: [], tier: null }).get(fp);
  for (const b of bins) if (b.account_fp && sent.bins[`${b.account_fp}|${b.bin_start}|${b.model}`] !== b.hash) acc(b.account_fp).bins.push(b);
  for (const s of samples) {
    if (!s.account_fp || s.observed_at <= (sent.samples[s.account_fp] || 0)) continue;
    const a = acc(s.account_fp); a.samples.push(...sampleRows(s)); a.tier = s.tier;
  }
  const out = [];
  for (const [fp, a] of accounts) {
    if (!a.bins.length && !a.samples.length) continue;
    const tier = a.tier || a.bins.at(-1)?.tier || null;
    const chunks = Math.max(Math.ceil(a.bins.length / MAX_BINS), Math.ceil(a.samples.length / MAX_SAMPLES));
    for (let j = 0; j < chunks; j++) {
      const bs = a.bins.slice(j * MAX_BINS, (j + 1) * MAX_BINS), ss = a.samples.slice(j * MAX_SAMPLES, (j + 1) * MAX_SAMPLES);
      if (!bs.length && !ss.length) continue;
      out.push({ account_fp: fp, tier, bins: bs.map(binOut),
        samples: ss.map(s => ({ observed_at: s.observed_at, gauge: s.gauge, utilization: s.utilization, resets_at: s.resets_at, source: s.source, tier: s.tier })),
        client: { version: CLIENT_VERSION, collector: ['proxy', 'teamclaude'].includes(cfg.collector) ? cfg.collector : 'transcript' }, _bins: bs });
    }
  }
  return { payloads: out, unverified };
}
export const wire = p => { const { _bins, ...rest } = p; return rest; };

export async function submit({ dryRun = false, log = console.log, fetchImpl = fetch } = {}) {
  const cfg = loadConfig();
  const { payloads, unverified } = pendingPayloads({ cfg });
  if (dryRun) {
    log('── 서버로 보낼 내용 (5분 단위 토큰 합·게이지 샘플·계정 지문·요금제. 본문·경로·요청 ID·호스트명·이메일·인증값은 보내지 않음) ──');
    if (payloads[0]) log(JSON.stringify({ ...wire(payloads[0]), bins: wire(payloads[0]).bins.slice(0, 3), samples: wire(payloads[0]).samples.slice(0, 4) }, null, 2));
    log(`보낼 묶음 ${payloads.length}개${unverified ? ` · 계정 미확정 bin ${unverified}개(보내지 않음)` : ''}`);
    return { sent: 0, preview: payloads.length };
  }
  if (cfg.consent_version !== CONSENT_VERSION || !cfg.consent_v2_at) { log('0.2 수집 범위 동의 전이라 보내지 않습니다. `jinsil setup`으로 동의하세요.'); return { sent: 0 }; }
  if (!payloads.length) { log('보낼 새 데이터 없음'); return { sent: 0 }; }
  const device = loadDevice();
  if (!device?.device_token) throw Error('not_logged_in');
  const server = device.server || cfg.server;
  const sent = readJson(sentFile(), { bins: {}, samples: {} });
  const results = [];
  for (const p of payloads) {
    let http = 0, body = null;
    try {
      const r = await fetchImpl(`${server}/v2/bins`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.device_token}` },
        body: JSON.stringify(wire(p)), signal: AbortSignal.timeout(15000) });
      http = r.status; try { body = await r.json(); } catch {}
    } catch {}
    if (http === 200 || http === 201) {
      for (const b of p._bins) sent.bins[`${p.account_fp}|${b.bin_start}|${b.model}`] = b.hash;
      const maxS = p.samples.reduce((m, s) => Math.max(m, s.observed_at), 0);
      if (maxS) sent.samples[p.account_fp] = Math.max(sent.samples[p.account_fp] || 0, maxS);
    }
    results.push({ http, status: body?.status || null, reason: body?.reason || null, bins: p.bins.length, samples: p.samples.length });
  }
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sentFile(), JSON.stringify(sent), { mode: 0o600 });
  log(results.map(r => `HTTP ${r.http} ${r.status || ''}${r.reason ? ` (${r.reason})` : ''} · bin ${r.bins} · 샘플 ${r.samples}`).join('\n'));
  return { sent: results.filter(r => r.http === 200 || r.http === 201).length, results };
}
