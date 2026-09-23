#!/usr/bin/env node
// 외부 API·인증 없이 실제 기록기 프로세스(jinsil recorder)를 로컬 TLS 서버와 대조한다. collector v2 25개 회귀 이식본.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

if (process.platform === 'win32') { console.log('verify-local: 프록시 모드 검증은 Unix 전용 — 건너뜀'); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-verify-'));
fs.chmodSync(dir, 0o700);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
const usage = { input_tokens: 11, output_tokens: 0, cache_creation_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }, cache_read_input_tokens: 40 };
const event = (value, eol = '\n') => `event: ${value.type}${eol}data: ${JSON.stringify(value)}${eol}${eol}`;
function stream({ eol = '\n', split = true, stop = true } = {}) {
  const u = { ...usage };
  if (!split) delete u.cache_creation;
  return event({ type: 'message_start', message: { id: 'msg_fixture', model: 'claude-opus-5-5', usage: u } }, eol)
    + event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'DO_NOT_STORE_BODY_한글' } }, eol)
    + [3, 7, 7].map(n => event({ type: 'message_delta', usage: { output_tokens: n, cache_creation_input_tokens: 50 } }, eol)).join('')
    + (stop ? event({ type: 'message_stop' }, eol) : '');
}
const bodies = new Map();
const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, async (req, res) => {
  for await (const chunk of req) { /* synthetic request only */ }
  const name = new URL(req.url, 'https://localhost').searchParams.get('case');
  let body = Buffer.from(name === 'json' ? JSON.stringify({ model: 'claude-opus-5-5', usage: { ...usage, output_tokens: 7 } })
    : stream({ eol: name === 'crlf' ? '\r\n' : '\n', split: name !== 'unsplit', stop: name !== 'incomplete' }));
  const headers = { 'content-type': name === 'json' ? 'application/json' : 'text/event-stream',
    'request-id': `fixture_${name}`, 'anthropic-ratelimit-unified-5h-utilization': '0.2',
    'anthropic-ratelimit-unified-7d-utilization': '0.1', 'anthropic-ratelimit-unified-7d-reset': '1900000000' };
  if (['gzip', 'br', 'deflate'].includes(name)) {
    body = ({ gzip: zlib.gzipSync, br: zlib.brotliCompressSync, deflate: zlib.deflateSync })[name](body);
    headers['content-encoding'] = name;
  }
  // Fetch returns decoded bodies; retain the decoded expected bytes for comparison.
  bodies.set(name, ['gzip', 'br', 'deflate'].includes(name) ? Buffer.from(stream()) : body);
  if (name === 'abort') {
    res.writeHead(200, headers);
    res.write(event({ type: 'message_start', message: { model: 'claude-opus-5-5', usage } }));
    setTimeout(() => res.destroy(), 20);
    return;
  }
  if (name === 'badgzip') {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
    res.end('not gzip');
    return;
  }
  if (name === 'rate_limit') {
    res.writeHead(429, { ...headers, 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    return;
  }
  res.writeHead(200, headers);
  // Arbitrary byte boundaries exercise the streaming parser.
  for (let i = 0; i < body.length; i += 13) res.write(body.subarray(i, i + 13));
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let child;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}
const readRows = () => {
  const [head, ...lines] = fs.readFileSync(path.join(dir, 'ledger', 'usage.tsv'), 'utf8').trim().split('\n');
  return lines.map(l => Object.fromEntries(l.split('\t').map((v, i) => [head.split('\t')[i], v])));
};
try {
  child = spawn(process.execPath, [path.join(here, '..', 'bin', 'jinsil.mjs'), 'recorder'], {
    env: { ...process.env, LEDGER_PORT: '0', LEDGER_UPSTREAM: `https://localhost:${server.address().port}`, LEDGER_DIR: path.join(dir, 'ledger'), JINSIL_HOME: path.join(dir, 'home'), NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', b => { errors += b; });
  // Discover the port from the child's listening socket on macOS (the v0 banner prints configured 0).
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error(`Proxy exited: ${errors}`); }),
    new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Proxy startup timeout')), 5000); t.unref(); })]);
  const sockets = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
  const port = sockets.match(/n127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port, 'Loopback listener must exist');
  for (const name of ['lf', 'crlf', 'json', 'gzip', 'br', 'deflate', 'unsplit', 'incomplete']) {
    await check(name, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages?case=${name}`, { method: 'POST', body: '{}' });
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200);
      assert.deepEqual(body, bodies.get(name), 'Forwarded response differs');
      // Decompression and ledger writing run on a separate event stream.
      let rows;
      for (let i = 0; i < 50; i++) {
        rows = readRows().filter(r => r.request_id === `fixture_${name}`);
        if (rows.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(rows.length, 1, 'Must record exactly one row per request');
      const r = rows[0];
      if (name === 'incomplete') {
        assert.ok(r.complete === '0' || /incomplete|truncated/.test(r.quality || ''), 'Missing message_stop must not look like a complete response');
        return;
      }
      if (name === 'unsplit') {
        assert.ok(r.cache_write_unknown === '50' || /unknown|unsplit/.test(r.quality || ''), 'Unknown cache TTL must not silently become 5m');
        return;
      }
      assert.deepEqual(['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'].map(k => +r[k]), [11, 7, 20, 30, 40]);
      assert.equal(r.u7d, '0.1');
    });
  }
  await check('parallel_requests', async () => {
    await Promise.all(Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${port}/v1/messages?case=parallel`, { method: 'POST', body: '{}' }).then(r => r.arrayBuffer())));
    const rows = readRows().filter(r => r.request_id === 'fixture_parallel');
    assert.equal(rows.length, 8);
    assert.ok(rows.every(r => +r.output === 7 && +r.cache_write_1h === 30));
  });
  await check('body_privacy_and_permissions', () => {
    const file = path.join(dir, 'ledger', 'usage.tsv');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('DO_NOT_STORE_BODY'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });
  const columns = fs.readFileSync(path.join(dir, 'ledger', 'usage.tsv'), 'utf8').split('\n')[0].split('\t');
  function compute(records) {
    const file = path.join(dir, 'compute.tsv');
    records = records.map((r, i) => ({ schema_version: 3, usage_observed: 1, cache_write_unknown: 0, local_request_id: `compute_${i}`, ...r }));
    fs.writeFileSync(path.join(dir, 'lifecycle.jsonl'), records.flatMap(r => ['start', 'end'].map(type => JSON.stringify({ type, local_request_id: r.local_request_id }))).join('\n') + '\n');
    fs.writeFileSync(file, columns.join('\t') + '\n' + records.map(r => columns.map(k => r[k] ?? '').join('\t')).join('\n') + '\n');
    return JSON.parse(execFileSync(process.execPath, [path.join(here, '..', 'src', 'compute.mjs'), '--ledger', file], { encoding: 'utf8' }));
  }
  const row = { ts_ms: 1790152000000, model: 'claude-opus-5-5', input: 11, output: 7, cache_write_5m: 20, cache_write_1h: 30, cache_read: 40,
    u5h: 0.2, u7d: 0.1, http_status: 200, reset_5h: 1900000000, reset_7d: 1900000000, complete: 1, quality: 'complete', stream: 1 };
  await check('component_arithmetic', () => {
    const w = compute([row]).windows.find(w => w.gauge === '7d');
    assert.equal(w.cost_usd, 0.000532); // Preserve small request costs rather than rounding cents.
    assert.equal(w.usd_per_100pct, null);
  });
  await check('reset_identity_even_when_gauge_rises', () => {
    const w = compute([row, { ...row, ts_ms: row.ts_ms + 86400000, u5h: 0.3, u7d: 0.15, reset_7d: 1900604800 }]).windows.filter(w => w.gauge === '7d');
    assert.equal(w.length, 2, 'Different reset windows must not be merged merely because the gauge increased');
  });
  await check('unpriced_model_blocks_extrapolation', () => {
    const w = compute([row, { ...row, ts_ms: row.ts_ms + 1000, u7d: 0.2, model: 'unknown-model', output: 1000000 }]).windows.find(w => w.gauge === '7d');
    assert.equal(w.usd_per_100pct, null, 'Missing prices must not produce an apparently complete 100% estimate');
  });
  await check('cache_unknown_blocks_total', () => {
    const p = compute([{ ...row, cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown: 50 }]);
    assert.equal(p.totals.cost_usd, null);
    assert.ok(p.totals.quality.includes('cache_ttl_unknown'));
  });
  await check('incomplete_blocks_total', () => {
    const p = compute([{ ...row, complete: 0 }]);
    assert.equal(p.totals.cost_usd, null);
    assert.ok(p.totals.quality.includes('incomplete_usage'));
  });
  await check('reset_jitter_does_not_split', () => {
    const p = compute([row, { ...row, ts_ms: row.ts_ms + 1000, reset_7d: '2030-03-17T17:46:40.400Z', u7d: 0.11 }]);
    assert.equal(p.windows.filter(w => w.gauge === '7d').length, 1);
  });
  await check('missing_gauge_retains_tokens', () => {
    const p = compute([{ ...row, u5h: '', u7d: '' }]);
    assert.equal(p.totals.tokens_by_model[row.model].output, 7);
    assert.equal(p.windows.length, 0);
  });
  await check('duplicate_ids_flagged_not_silently_removed', () => {
    const p = compute([{ ...row, local_request_id: 'same' }, { ...row, local_request_id: 'same' }]);
    assert.equal(p.totals.cost_usd, null);
    assert.ok(p.totals.quality.includes('duplicate_local_id'));
  });
  await check('header_boundary_estimate_withheld', () => {
    const p = compute([row, { ...row, ts_ms: row.ts_ms + 1000, u7d: 0.4 }]);
    const w = p.windows.find(w => w.gauge === '7d');
    assert.equal(w.usd_per_100pct, null);
    assert.ok(w.extrapolation_blockers.includes('header_boundary_unverified'));
  });
  await check('unfinished_start_detected', () => {
    compute([row]);
    fs.appendFileSync(path.join(dir, 'lifecycle.jsonl'), JSON.stringify({ type: 'start', local_request_id: 'crashed' }) + '\n');
    const p = JSON.parse(execFileSync(process.execPath, [path.join(here, '..', 'src', 'compute.mjs'), '--ledger', path.join(dir, 'compute.tsv')], { encoding: 'utf8' }));
    assert.equal(p.unmatched_requests, 1);
    assert.equal(p.totals.cost_usd, null);
  });
  for (const [name, flag] of [['abort', 'upstream_aborted'], ['badgzip', 'decode_error'], ['rate_limit', 'http_error']]) {
    await check(name, async () => {
      try { await (await fetch(`http://127.0.0.1:${port}/v1/messages?case=${name}`, { method: 'POST', body: '{}' })).arrayBuffer(); } catch { /* Expected transport/decode failure. */ }
      let records = [];
      for (let i = 0; i < 50; i++) {
        records = readRows().filter(r => r.request_id === `fixture_${name}`);
        if (records.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(records.length, 1);
      assert.equal(records[0].complete, '0');
      assert.ok(records[0].quality.includes(flag));
    });
  }
  await check('health_and_lifecycle', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/_ledger/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { schema: 3, active_requests: 0, write_failures: 0 });
    const events = fs.readFileSync(path.join(dir, 'ledger', 'lifecycle.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.type === 'start').length, 19);
    assert.equal(events.filter(e => e.type === 'end').length, 19);
    assert.equal(new Set(readRows().map(r => r.local_request_id)).size, 19);
  });
  await check('write_failure_is_visible_but_response_passes', async () => {
    const ledger = path.join(dir, 'ledger', 'usage.tsv');
    fs.renameSync(ledger, ledger + '.test-backup');
    fs.mkdirSync(ledger);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages?case=writefailure`, { method: 'POST', body: '{}' });
      assert.equal(await response.text(), stream());
      const h = await fetch(`http://127.0.0.1:${port}/_ledger/health`);
      assert.equal(h.status, 503);
      assert.ok((await h.json()).write_failures > 0);
    } finally {
      fs.rmdirSync(ledger);
      fs.renameSync(ledger + '.test-backup', ledger);
    }
  });
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const report = { tested_at: new Date().toISOString(), network: 'loopback_only', directory: dir,
  passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results };
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
