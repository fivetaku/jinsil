// CLI 명령: setup/uninstall(서비스 파일은 dry-run), systemd 유닛 생성, submit 동의·멱등, report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { COLUMNS } from '../src/recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'jinsil.mjs');
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-cmd-'));
  return { d, env: { ...process.env, JINSIL_HOME: path.join(d, 'home'), JINSIL_SERVICE_DRYRUN: '1', JINSIL_LAUNCH_AGENTS_DIR: path.join(d, 'agents'),
    JINSIL_SYSTEMD_DIR: path.join(d, 'systemd'), JINSIL_NO_BROWSER: '1' } };
}
const run = (args, env, input) => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', input });

test('setup은 고정 런타임을 복사하고 서비스 파일을 쓰며, uninstall은 지운다', () => {
  const { d, env } = sandbox();
  const out = run(['setup', '--no-login', '--port', '10299'], env);
  assert.match(out, /서비스: (launchd|systemd)/);
  const app = path.join(d, 'home', 'app', JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  assert.ok(fs.existsSync(path.join(app, 'bin', 'jinsil.mjs')));
  assert.ok(fs.existsSync(path.join(app, 'src', 'recorder.mjs')));
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'home', 'config.json'), 'utf8'));
  assert.equal(cfg.port, 10299);
  assert.equal(fs.statSync(path.join(d, 'home', 'config.json')).mode & 0o777, 0o600);
  if (process.platform === 'darwin') {
    const plist = fs.readFileSync(path.join(d, 'agents', 'com.axwith.jinsil.plist'), 'utf8');
    assert.ok(plist.includes(path.join(app, 'bin', 'jinsil.mjs')) && plist.includes('<string>recorder</string>') && plist.includes('10299'));
  }
  run(['uninstall'], env);
  assert.ok(!fs.existsSync(path.join(d, 'agents', 'com.axwith.jinsil.plist')));
  assert.ok(!fs.existsSync(path.join(d, 'home', 'app')));
  run(['uninstall', '--purge'], env);
  assert.ok(!fs.existsSync(path.join(d, 'home')));
});

test('systemd 유닛은 기록기를 고정 런타임으로 실행한다', async () => {
  const { unitContent } = await import('../src/service.mjs');
  const u = unitContent({ node: '/usr/bin/node', entry: '/h/.jinsil/app/0.1.0/bin/jinsil.mjs', port: 10199 });
  assert.match(u, /ExecStart="\/usr\/bin\/node" "\/h\/\.jinsil\/app\/0\.1\.0\/bin\/jinsil\.mjs" recorder/);
  assert.match(u, /Restart=always/);
});

function seedLedger(home) {
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const T0 = Date.now() - 3600000;
  const rows = [0.10, 0.11, 0.12, 0.13, 0.14].map((v, i) => ({ ts_ms: T0 + i * 1000, started_ms: T0 + i * 1000 - 100, ended_ms: T0 + i * 1000 + 100,
    model: 'claude-opus-5-5', input: 100000, output: 10, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cache_write_unknown: 0,
    u5h: v, u7d: 0.02 + i * 0.01, reset_5h: Math.floor(T0 / 1000) + 18000, reset_7d: Math.floor(T0 / 1000) + 500000, http_status: 200, stream: 1,
    schema_version: 3, local_request_id: `s${i}`, complete: 1, usage_observed: 1, quality: 'complete', account_fp: 'f'.repeat(64), tier: 'default_claude_max_5x' }));
  fs.writeFileSync(path.join(dir, 'usage.tsv'), COLUMNS.join('\t') + '\n' + rows.map(r => COLUMNS.map(c => r[c] ?? '').join('\t')).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'lifecycle.jsonl'), rows.flatMap(r => ['start', 'end'].map(type => JSON.stringify({ type, local_request_id: r.local_request_id, at_ms: r.started_ms }))).join('\n') + '\n');
}

test('submit: 동의 없이는 보내지 않고, --yes 후 전송·재실행 시 중복 전송하지 않는다', async () => {
  const { d, env } = sandbox();
  seedLedger(env.JINSIL_HOME);
  const got = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"status":"accepted"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(env.JINSIL_HOME, 'device.json'), JSON.stringify({ server: url, device_token: 'dev_test', device_id: 'd1' }));
  try {
    const dry = await runAsync(['submit', '--dry-run'], env);
    assert.match(dry, /서버로 보낼 내용/);
    assert.equal(got.length, 0);
    const refused = await runAsync(['submit'], env, '');
    assert.match(refused, /동의하지 않아/);
    assert.equal(got.length, 0);
    await runAsync(['submit', '--yes'], env);
    assert.ok(got.length >= 2, '5h 1개 + 7d 구간');
    const p = got[0].body;
    assert.equal(got[0].auth, 'Bearer dev_test');
    assert.ok(p.interval_id && p.account_fp && p.tokens_by_model && p.client.version);
    const text = JSON.stringify(got.map(g => g.body));
    for (const forbidden of ['local_request_id', 'request_id', 'message_id', 'started_ms', 'email']) assert.ok(!text.includes(forbidden), forbidden);
    const n = got.length;
    await runAsync(['submit'], env);
    assert.equal(got.length, n, '이미 수용된 구간은 다시 보내지 않음');
    const cfg = JSON.parse(fs.readFileSync(path.join(env.JINSIL_HOME, 'config.json'), 'utf8'));
    assert.ok(cfg.consented_at);
    // 새 홈: --auto on --yes는 동의까지 기록, --auto on 단독은 동의 없이 대기
    const s2 = sandbox();
    await runAsync(['submit', '--auto', 'on'], s2.env);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s2.env.JINSIL_HOME, 'config.json'), 'utf8')).consented_at, null);
    await runAsync(['submit', '--auto', 'on', '--yes'], s2.env);
    assert.ok(JSON.parse(fs.readFileSync(path.join(s2.env.JINSIL_HOME, 'config.json'), 'utf8')).consented_at);
    const rep = await runAsync(['report'], env);
    assert.match(rep, /주간 100% 환산/);
    assert.match(rep, /구독료 \$100/);
  } finally { server.close(); }
});

// 서버와 같은 프로세스 이벤트 루프를 막지 않도록 비동기 실행
import { execFile } from 'node:child_process';
function runAsync(args, env, input) {
  return new Promise((resolve, reject) => {
    const c = execFile(process.execPath, [bin, ...args], { env, encoding: 'utf8' }, (e, out, err) => e ? reject(Object.assign(e, { out, err })) : resolve(out));
    if (input !== undefined) c.stdin.end(input); else c.stdin.end();
  });
}

test('setup은 jinsil 명령을 PATH에 등록하고(중복 없이), uninstall은 되돌리며 기존 셸 설정은 보존한다', () => {
  const { d, env } = sandbox();
  const rc = path.join(d, 'zshrc');
  fs.writeFileSync(rc, 'export FOO=1\nalias ll="ls -l"\n');
  const e = { ...env, JINSIL_RC_FILES: rc };
  const out = run(['setup', '--no-login', '--port', '10298'], e);
  assert.match(out, /명령 등록: .*bin\/jinsil/);
  const shim = path.join(d, 'home', 'bin', 'jinsil');
  assert.equal(fs.statSync(shim).mode & 0o111, 0o111);
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
  assert.equal(execFileSync(shim, ['--version'], { env: e, encoding: 'utf8' }).trim(), version);
  run(['setup', '--no-login', '--port', '10298'], e);
  const text = fs.readFileSync(rc, 'utf8');
  assert.equal(text.split('# >>> jinsil >>>').length - 1, 1);
  assert.ok(text.startsWith('export FOO=1\nalias ll="ls -l"\n') && text.includes(`export PATH="${path.join(d, 'home', 'bin')}":"$PATH"`));
  const zsh = execFileSync('/bin/sh', ['-c', `. "${rc}" && command -v jinsil`], { encoding: 'utf8' }).trim();
  assert.equal(zsh, shim);
  run(['uninstall'], e);
  assert.ok(!fs.existsSync(shim));
  assert.equal(fs.readFileSync(rc, 'utf8'), 'export FOO=1\nalias ll="ls -l"\n');
  const { d: d2, env: env2 } = sandbox();
  const rc2 = path.join(d2, 'zshrc');
  run(['setup', '--no-login', '--no-path', '--port', '10297'], { ...env2, JINSIL_RC_FILES: rc2 });
  assert.ok(!fs.existsSync(rc2) && !fs.existsSync(path.join(d2, 'home', 'bin')));
});
