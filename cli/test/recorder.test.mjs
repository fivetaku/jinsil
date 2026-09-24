// 기록기 schema 3 추가 기능: 계정 지문·요금제 기록, 인증값 비저장, 유휴 usage 스냅샷.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { accountFingerprint } from '../src/recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'sk-ant-oat01-FAKE_TEST_TOKEN_should_never_be_written';
const UUID = '11111111-2222-4333-8444-555555555555';

test({ skip: process.platform === 'win32' && '프록시 모드 검증은 openssl·lsof 필요(Unix)' }, '계정 지문·요금제를 기록하고 인증값은 어디에도 쓰지 않으며, 유휴 시 usage 스냅샷을 남긴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-rec-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const seen = { profile: 0, usage: 0, profileAuth: null };
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url === '/api/oauth/profile') {
      seen.profile++; seen.profileAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ account: { uuid: UUID, email: 'nobody@example.com' }, organization: { rate_limit_tier: 'default_claude_max_5x' } }));
    }
    if (req.url === '/api/oauth/usage') {
      seen.usage++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 3, resets_at: '2030-01-05T00:00:00Z' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_fixture', 'anthropic-ratelimit-unified-5h-utilization': '0.12' });
    res.end(JSON.stringify({ id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'jinsil.mjs'), 'recorder'], {
    env: { ...process.env, LEDGER_PORT: '0', LEDGER_UPSTREAM: `https://localhost:${server.address().port}`, LEDGER_DIR: path.join(dir, 'data'),
      JINSIL_HOME: path.join(dir, 'home'), NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem'), LEDGER_IDLE_MS: '300', LEDGER_SNAPSHOT_EVERY_MS: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await once(child.stdout, 'data');
    const port = execFileSync(fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).match(/n127\.0\.0\.1:(\d+)/)[1];
    for (const auth of [`Bearer ${SECRET}`, `Bearer ${SECRET}`, null]) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body: '{}' });
      await r.text();
    }
    let rows = [];
    for (let i = 0; i < 100 && rows.length < 3; i++) {
      const [head, ...lines] = fs.readFileSync(path.join(dir, 'data', 'usage.tsv'), 'utf8').replace(/\n+$/, '').split('\n');
      rows = lines.map(l => Object.fromEntries(l.split('\t').map((v, k) => [head.split('\t')[k], v])));
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(rows.length, 3);
    assert.equal(rows[0].account_fp, accountFingerprint(UUID));
    assert.equal(rows[0].tier, 'default_claude_max_5x');
    assert.equal(rows[0].complete, '1');
    assert.equal(rows[2].account_fp, '');
    assert.ok(rows[2].quality.includes('account_unknown'));
    assert.equal(seen.profile, 1, '같은 인증값은 프로필을 한 번만 조회');
    assert.equal(seen.profileAuth, `Bearer ${SECRET}`);
    // 유휴 스냅샷
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'data', 'snapshots.jsonl')); i++) await new Promise(r => setTimeout(r, 50));
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'snapshots.jsonl'), 'utf8').trim().split('\n')[0]);
    assert.equal(snap.account_fp, accountFingerprint(UUID));
    assert.equal(snap.five_hour.utilization, 12);
    // 인증값·UUID·이메일은 로컬 파일 어디에도 없어야 한다
    for (const f of fs.readdirSync(path.join(dir, 'data'))) {
      const text = fs.readFileSync(path.join(dir, 'data', f), 'utf8');
      assert.ok(!text.includes(SECRET) && !text.includes('FAKE_TEST_TOKEN'), `${f}에 인증값`);
      assert.ok(!text.includes(UUID), `${f}에 계정 UUID`);
      assert.ok(!text.includes('nobody@example.com'), `${f}에 이메일`);
    }
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit');
    server.closeAllConnections(); server.close();
  }
});
