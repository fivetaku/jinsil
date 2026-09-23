// 클진요 로컬 기록기 (schema 3). 원문·인증은 저장하지 않고, 관측된 사용량과 기록 품질만 로컬에 남긴다.
// collector/ledger-proxy.mjs(v2)에서 이식: 계정 지문·요금제 열, 유휴 사용량 스냅샷, 자동 제출 훅을 추가했다.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { dataDir } from './paths.mjs';

export const SCHEMA = 3;
export const COLUMNS = ['ts_ms', 'model', 'input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read',
  'u5h', 'u7d', 'u7d_oi', 'reset_5h', 'reset_7d', 'unified_status', 'http_status', 'stream', 'request_id',
  'schema_version', 'local_request_id', 'message_id', 'started_ms', 'ended_ms', 'cache_write_unknown',
  'complete', 'quality', 'usage_observed', 'account_fp', 'tier'];
export const LEDGER_FILE = 'usage.tsv';
export const LIFECYCLE_FILE = 'lifecycle.jsonl';
export const SNAPSHOT_FILE = 'snapshots.jsonl';

// 계정 UUID는 메모리에서만 지문으로 바꾼다. 서버에는 이 지문만 간다.
export const accountFingerprint = uuid => createHash('sha256').update('jinsil/v1/' + uuid).digest('hex');

export function startRecorder({
  port = Number(process.env.LEDGER_PORT || 10199),
  upstream = process.env.LEDGER_UPSTREAM || 'https://api.anthropic.com',
  dir = process.env.LEDGER_DIR || dataDir(),
  idleMs = Number(process.env.LEDGER_IDLE_MS || 60000),
  snapshotEveryMs = Number(process.env.LEDGER_SNAPSHOT_EVERY_MS || 300000),
  idleWatchMs = Number(process.env.LEDGER_IDLE_WATCH_MS || 30 * 60000),
  onIdle = null,
} = {}) {
  const UPSTREAM = new URL(upstream);
  if (UPSTREAM.protocol !== 'https:' || UPSTREAM.username || UPSTREAM.password || UPSTREAM.pathname !== '/') {
    throw Error('LEDGER_UPSTREAM must be an HTTPS origin without credentials or path');
  }
  const routedUpstream = UPSTREAM.hostname !== 'api.anthropic.com';
  const TSV = path.join(dir, LEDGER_FILE);
  const EVENTS = path.join(dir, LIFECYCLE_FILE);
  const SNAPSHOTS = path.join(dir, SNAPSHOT_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const header = COLUMNS.join('\t') + '\n';
  if (!fs.existsSync(TSV)) fs.writeFileSync(TSV, header, { mode: 0o600 });
  else if (fs.readFileSync(TSV, 'utf8').split('\n')[0] + '\n' !== header) throw Error('Ledger schema mismatch; use a new LEDGER_DIR');
  fs.chmodSync(TSV, 0o600);
  // 한 디렉터리에 기록 프로세스 하나만. 잠금에 적힌 PID가 이미 죽었으면(크래시·정전) 남은 잠금을 정리하고 연다.
  const LOCK = path.join(dir, 'writer.lock');
  const lockFd = acquireLock(LOCK);
  fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, started_ms: Date.now() }));
  let lockReleased = false;
  const releaseLock = () => { if (lockReleased) return; lockReleased = true; try { fs.closeSync(lockFd); fs.unlinkSync(LOCK); } catch {} };
  process.on('exit', releaseLock);

  let writeFailures = 0;
  const active = new Set();
  let lastActivity = 0;
  function append(file, text) {
    try {
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return true;
    } catch {
      writeFailures++;
      console.error('[jinsil] recording_failed; this measurement is not complete');
      return false;
    }
  }
  const clean = value => String(value ?? '').replace(/[\t\r\n]/g, ' ');
  const event = (type, acc) => append(EVENTS, JSON.stringify({ type, local_request_id: acc.local_request_id,
    at_ms: Date.now(), complete: acc.complete ?? 0 }) + '\n');

  // 인증값 → 계정 지문. 키는 인증값의 해시, 값은 메모리에만. 인증값은 조회에 쓰고 디스크에 쓰지 않는다.
  const accounts = new Map(); // authHash -> { promise, fp, tier, auth, failed }
  function upstreamJson(pathname, auth) {
    return new Promise(resolve => {
      const r = https.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 443, path: pathname, method: 'GET',
        headers: { authorization: auth, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }, timeout: 10000 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; if (body.length > 1 << 20) res.destroy(); });
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, json: null }); } });
        res.on('error', () => resolve({ status: 0, json: null }));
      });
      r.on('timeout', () => r.destroy());
      r.on('error', () => resolve({ status: 0, json: null }));
      r.end();
    });
  }
  function lookupAccount(auth) {
    const key = createHash('sha256').update(auth).digest('hex');
    let a = accounts.get(key);
    if (a && !a.failed) return a;
    a = { auth, fp: null, tier: null, failed: false };
    a.promise = upstreamJson('/api/oauth/profile', auth).then(({ status, json }) => {
      const uuid = json?.account?.uuid;
      if (status === 200 && typeof uuid === 'string' && uuid) {
        a.fp = accountFingerprint(uuid);
        a.tier = typeof json.organization?.rate_limit_tier === 'string' ? json.organization.rate_limit_tier : null;
      } else a.failed = true;
      return a;
    });
    accounts.set(key, a);
    return a;
  }

  function gaugeFields(h) {
    return Object.fromEntries([
      ['u5h', '5h-utilization'], ['u7d', '7d-utilization'], ['u7d_oi', '7d_oi-utilization'],
      ['reset_5h', '5h-reset'], ['reset_7d', '7d-reset'], ['unified_status', 'status'],
    ].map(([key, suffix]) => [key, h[`anthropic-ratelimit-unified-${suffix}`]]).concat([['request_id', h['request-id']]]));
  }
  function applyUsage(acc, u, flags) {
    if (!u || typeof u !== 'object') return;
    const number = value => Number.isSafeInteger(value) && value >= 0;
    const set = (target, value) => {
      if (value === undefined) return;
      if (!number(value)) { flags.add('invalid_usage'); return; }
      if (acc[target] !== undefined && value < acc[target]) flags.add('usage_decreased');
      acc[target] = value;
    };
    set('input', u.input_tokens);
    set('output', u.output_tokens);
    set('cache_read', u.cache_read_input_tokens);
    set('_cache_total', u.cache_creation_input_tokens);
    const cc = u.cache_creation;
    if (cc) {
      set('cache_write_5m', cc.ephemeral_5m_input_tokens);
      set('cache_write_1h', cc.ephemeral_1h_input_tokens);
    }
    acc.usage_observed = 1;
  }
  function makeTap(isSSE, acc, flags) {
    let buf = '', stopped = false, sawStart = false, sawFinalUsage = false, disabled = false;
    const decoder = new StringDecoder('utf8');
    function parse(text) {
      let value;
      try { value = JSON.parse(text); } catch { flags.add('parse_error'); return; }
      if (!isSSE) {
        acc.model = value.model || '';
        acc.message_id = value.id || '';
        applyUsage(acc, value.usage, flags);
        stopped = Boolean(value.usage && value.type !== 'error');
      } else if (value.type === 'message_start') {
        if (sawStart) flags.add('duplicate_message_start');
        sawStart = true;
        acc.model = value.message?.model || '';
        acc.message_id = value.message?.id || '';
        applyUsage(acc, value.message?.usage, flags);
      } else if (value.type === 'message_delta') {
        if (value.usage?.output_tokens !== undefined) sawFinalUsage = true;
        applyUsage(acc, value.usage, flags);
      } else if (value.type === 'message_stop') stopped = true;
      else if (value.type === 'error') flags.add('stream_error');
    }
    function push(text) {
      if (disabled) return;
      buf += text;
      if (isSSE) {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buf))) {
          const block = buf.slice(0, match.index);
          buf = buf.slice(match.index + match[0].length);
          const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (data) parse(data);
        }
      }
      if (buf.length > (isSSE ? 1024 * 1024 : 16 * 1024 * 1024)) {
        flags.add('parser_limit'); disabled = true; buf = '';
      }
    }
    return {
      push: chunk => push(decoder.write(chunk)),
      end() {
        push(decoder.end());
        if (isSSE) { if (buf.trim()) flags.add('truncated_event'); }
        else if (!disabled) parse(buf);
        if (!stopped || (isSSE && (!sawStart || !sawFinalUsage))) flags.add('incomplete_stream');
        return stopped;
      },
    };
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/_ledger/health') {
      res.writeHead(writeFailures ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schema: SCHEMA, active_requests: active.size, write_failures: writeFailures }));
      return;
    }
    const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url);
    const flags = new Set();
    const acc = { schema_version: SCHEMA, local_request_id: randomUUID(), started_ms: Date.now(),
      usage_observed: 0, complete: 0 };
    let account = null;
    if (isMessages) {
      active.add(acc.local_request_id); event('start', acc);
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && /^Bearer\s+\S+/.test(auth)) account = lookupAccount(auth);
      if (routedUpstream) flags.add('routed_upstream');
    }
    let finished = false, dec, tap, upResRef;
    function finish(reason, normal = false) {
      if (!isMessages || finished) return;
      finished = true;
      if (reason) flags.add(reason);
      let stopped = false;
      if (normal && tap) stopped = tap.end();
      if (!normal) flags.add('incomplete_stream');
      const split = (acc.cache_write_5m ?? 0) + (acc.cache_write_1h ?? 0);
      if (acc._cache_total !== undefined) {
        if (split > acc._cache_total) flags.add('cache_split_mismatch');
        acc.cache_write_unknown = Math.max(0, acc._cache_total - split);
        if (acc.cache_write_unknown) flags.add('cache_ttl_unknown');
        if (!acc.cache_write_unknown && acc._cache_total === 0) {
          acc.cache_write_5m ??= 0; acc.cache_write_1h ??= 0;
        }
      } else if (acc.cache_write_5m !== undefined && acc.cache_write_1h !== undefined) acc.cache_write_unknown = 0;
      else flags.add('missing_cache_usage');
      if (!acc.usage_observed || acc.input === undefined || acc.output === undefined || acc.cache_read === undefined) flags.add('missing_usage');
      if (!(acc.http_status >= 200 && acc.http_status < 300)) flags.add('http_error');
      // TTL 미확인·계정 미확인·라우터 경유는 단가/귀속 문제이지 응답 완료 여부가 아니다.
      const nonTransport = new Set(['cache_ttl_unknown', 'account_unknown', 'routed_upstream']);
      acc.ended_ms = Date.now(); acc.ts_ms ??= acc.started_ms;
      const write = () => {
        if (account) {
          if (account.fp) { acc.account_fp = account.fp; acc.tier = account.tier ?? ''; }
          else flags.add('account_unknown');
        } else flags.add('account_unknown');
        acc.complete = normal && stopped && ![...flags].some(f => !nonTransport.has(f)) ? 1 : 0;
        acc.quality = [...flags].sort().join(',') || 'complete';
        if (append(TSV, COLUMNS.map(c => clean(acc[c])).join('\t') + '\n')) event('end', acc);
        active.delete(acc.local_request_id);
        lastActivity = Date.now();
      };
      dec?.destroy();
      // 프로필 조회가 끝날 때까지 최대 5초 기다린 뒤 기록한다(응답 전달과 무관).
      if (account && !account.fp && !account.failed) {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; write(); } }, 5000);
        account.promise.then(() => { if (!done) { done = true; clearTimeout(t); write(); } });
      } else write();
    }
    const headers = { ...req.headers, host: UPSTREAM.host };
    delete headers.connection;
    const up = https.request({ protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443, method: req.method, path: req.url, headers }, upRes => {
      upResRef = upRes;
      res.writeHead(upRes.statusCode, upRes.headers);
      if (isMessages) {
        const isSSE = String(upRes.headers['content-type'] || '').includes('text/event-stream');
        // ts_ms = 응답 헤더(게이지)를 받은 시각. 구간 경계 계산의 기준.
        Object.assign(acc, gaugeFields(upRes.headers), { ts_ms: Date.now(), http_status: upRes.statusCode, stream: isSSE ? 1 : 0 });
        tap = makeTap(isSSE, acc, flags);
        const enc = String(upRes.headers['content-encoding'] || '').toLowerCase();
        dec = enc === 'gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress() : enc === 'deflate' ? zlib.createInflate() : null;
        if (enc && enc !== 'identity' && !dec) flags.add('unsupported_encoding');
        if (dec) {
          dec.on('data', c => tap.push(c));
          dec.on('end', () => finish(null, true));
          dec.on('error', () => finish('decode_error'));
          upRes.on('data', c => { if (!finished) dec.write(c); });
          upRes.on('end', () => { if (!finished) dec.end(); });
        } else {
          upRes.on('data', c => tap.push(c));
          upRes.on('end', () => finish(null, true));
        }
      }
      upRes.on('aborted', () => { finish('upstream_aborted'); res.destroy(); });
      upRes.on('error', () => { finish('upstream_error'); res.destroy(); });
      upRes.pipe(res);
    });
    up.on('error', () => {
      finish('upstream_error');
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"type":"jinsil_recorder_upstream_error"}}'); }
      else res.destroy();
    });
    req.on('aborted', () => { finish('client_aborted'); up.destroy(); });
    res.on('close', () => {
      if (!res.writableFinished) { finish('client_aborted'); upResRef?.destroy(); up.destroy(); }
    });
    req.pipe(up);
  });

  // 유휴 스냅샷: 진행 중 요청 0, 마지막 활동 후 idleMs 경과 시 계정별 usage API 1회, 이후 snapshotEveryMs마다.
  // 활동이 idleWatchMs 이상 없으면 조회를 멈춘다. 429·오류면 간격을 두 배로(최대 1시간).
  const snapState = new Map(); // fp -> { last, backoff }
  let snapping = false;
  const timer = setInterval(async () => {
    if (snapping || active.size || !lastActivity) return;
    const now = Date.now();
    if (now - lastActivity < idleMs || now - lastActivity > idleWatchMs + idleMs) return;
    snapping = true;
    try {
      for (const a of accounts.values()) {
        if (!a.fp) continue;
        const s = snapState.get(a.fp) || { last: 0, backoff: snapshotEveryMs, lastActivitySeen: 0 };
        const due = s.lastActivitySeen !== lastActivity || now - s.last >= s.backoff;
        if (!due) continue;
        s.last = now; s.lastActivitySeen = lastActivity;
        const { status, json } = await upstreamJson('/api/oauth/usage', a.auth);
        const bucket = b => (b && Number.isFinite(b.utilization) && Number.isFinite(Date.parse(b.resets_at)))
          ? { utilization: b.utilization, resets_at: b.resets_at } : null;
        if (status === 200 && json) {
          s.backoff = snapshotEveryMs;
          append(SNAPSHOTS, JSON.stringify({ schema: 1, t: Date.now(), account_fp: a.fp, idle: active.size === 0,
            five_hour: bucket(json.five_hour), seven_day: bucket(json.seven_day) }) + '\n');
        } else s.backoff = Math.min(s.backoff * 2, 3600000);
        snapState.set(a.fp, s);
      }
      if (onIdle) await onIdle();
    } catch { /* 스냅샷 실패는 측정 품질에만 영향 */ } finally { snapping = false; }
  }, Math.min(5000, Math.max(50, Math.floor(idleMs / 4))));
  timer.unref();

  server.listen(port, '127.0.0.1', () => {
    console.log(`[jinsil] recorder 127.0.0.1:${server.address().port} | schema ${SCHEMA} | local recording only`);
  });
  const close = () => new Promise(resolve => { clearInterval(timer); server.close(() => { releaseLock(); resolve(); }); });
  return { server, close, dir };
}

// 남은 잠금 정리: PID가 없거나 살아 있지 않으면(ESRCH) 지우고 다시 연다. 살아 있으면 기존대로 실패(EEXIST).
export function acquireLock(LOCK) {
  try { return fs.openSync(LOCK, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid; } catch {}
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; }
    }
    if (alive) throw e;
    fs.unlinkSync(LOCK);
    return fs.openSync(LOCK, 'wx', 0o600);
  }
}
