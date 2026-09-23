// CLI 명령(0.2): setup/uninstall(서비스 파일은 dry-run), 동의 v2, 0.1.x 별칭 정리, v2 제출(upsert·미리보기·금지 필드), 로그인 호스트명 비전송.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'jinsil.mjs');
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-cmd-'));
  return { d, env: { ...process.env, JINSIL_HOME: path.join(d, 'home'), JINSIL_SERVICE_DRYRUN: '1', JINSIL_LAUNCH_AGENTS_DIR: path.join(d, 'agents'),
    JINSIL_SYSTEMD_DIR: path.join(d, 'systemd'), JINSIL_NO_BROWSER: '1', JINSIL_RC_FILES: path.join(d, 'zshrc') } };
}
const run = (args, env, input = '') => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', input });
function runAsync(args, env) {
  return new Promise((resolve, reject) => {
    const c = execFile(process.execPath, [bin, ...args], { env, encoding: 'utf8' }, (e, out, err) => e ? reject(Object.assign(e, { out, err })) : resolve(out));
    c.stdin.end();
  });
}
const cfgOf = d => JSON.parse(fs.readFileSync(path.join(d, 'home', 'config.json'), 'utf8'));

test('setup: 런타임 복사·collector 서비스 파일, 동의 없으면(비대화) 자동 제출 꺼짐, uninstall로 원복', () => {
  const { d, env } = sandbox();
  const out = run(['setup', '--no-login', '--port', '10299'], env);
  assert.match(out, /서비스: (launchd|systemd|windows-run)/);
  assert.match(out, /수집 동의/);
  const app = path.join(d, 'home', 'app', version);
  assert.ok(fs.existsSync(path.join(app, 'src', 'transcript.mjs')));
  const cfg = cfgOf(d);
  assert.equal(cfg.auto_submit, false); assert.equal(cfg.consent_v2_at, undefined);
  assert.match(cfg.install_id, /^[0-9a-f-]{36}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(d, 'home', 'config.json')).mode & 0o777, 0o600);
  if (process.platform === 'darwin') {
    const plist = fs.readFileSync(path.join(d, 'agents', 'com.axwith.jinsil.plist'), 'utf8');
    assert.ok(plist.includes(path.join(app, 'bin', 'jinsil.mjs')) && plist.includes('<string>collector</string>'));
  }
  run(['uninstall'], env);
  assert.ok(!fs.existsSync(path.join(d, 'agents', 'com.axwith.jinsil.plist')));
  run(['uninstall', '--purge'], env);
  assert.ok(!fs.existsSync(path.join(d, 'home')));
});

test('systemd 유닛은 collector를 고정 런타임으로 실행한다', async () => {
  const { unitContent } = await import('../src/service.mjs');
  const u = unitContent({ node: '/usr/bin/node', entry: '/h/.jinsil/app/0.2.0/bin/jinsil.mjs', port: 10199 });
  assert.match(u, /ExecStart="\/usr\/bin\/node" "\/h\/\.jinsil\/app\/0\.2\.0\/bin\/jinsil\.mjs" collector/);
});

test('setup --yes: 동의 v2 기록·자동 제출 켬, 0.1.x가 넣은 별칭 블록은 PATH만 남기고 사용자 줄은 보존, 기존 0.1 동의는 재사용 안 함', () => {
  const { d, env } = sandbox();
  const rc = path.join(d, 'zshrc');
  const user = `export FOO=1\nalias cc='claude'\n`;
  fs.writeFileSync(rc, user + `\n# >>> jinsil >>>\nexport PATH="/old/bin":"$PATH"\nalias cc='jinsil claude'\nalias claude='jinsil claude'\n# <<< jinsil <<<\n`);
  fs.mkdirSync(path.join(d, 'home'), { recursive: true });
  fs.writeFileSync(path.join(d, 'home', 'config.json'), JSON.stringify({ consented_at: '2026-09-23T00:00:00Z', auto_submit: true }));
  run(['setup', '--no-login', '--yes', '--port', '10298'], env);
  const text = fs.readFileSync(rc, 'utf8');
  assert.ok(text.startsWith(user), '사용자 줄 보존');
  assert.ok(!/jinsil claude/.test(text), '0.1 별칭 제거');
  assert.equal(text.split('# >>> jinsil >>>').length - 1, 1);
  assert.ok(text.includes(`export PATH="${path.join(d, 'home', 'bin')}":"$PATH"`));
  const cfg = cfgOf(d);
  assert.equal(cfg.consent_version, 2); assert.ok(cfg.consent_v2_at); assert.equal(cfg.auto_submit, true);
  const shim = path.join(d, 'home', 'bin', process.platform === 'win32' ? 'jinsil.cmd' : 'jinsil');
  assert.equal(execFileSync(shim, ['--version'], { env, encoding: 'utf8', shell: process.platform === 'win32' }).trim(), version);
  run(['uninstall'], env);
  assert.equal(fs.readFileSync(rc, 'utf8'), user);
});

const T = Date.now() - 2 * 3600000;
function seed(home, { consent = true } = {}) {
  const data = path.join(home, 'data');
  fs.mkdirSync(data, { recursive: true });
  const fp = 'f'.repeat(64);
  const messages = {};
  for (let i = 0; i < 6; i++) messages[`msg_${i}:req_${i}`] = { key: `msg_${i}:req_${i}`, ts: T + i * 10 * 60000, model: 'claude-opus-5',
    tokens: { input: 1000, output: 100, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown: 0 }, special: {}, sidechain: false };
  fs.writeFileSync(path.join(data, 'transcript_state.json'), JSON.stringify({ files: { '/Users/someone/secret/path.jsonl': { ino: 1, offset: 1 } }, messages, excluded: {} }));
  const s = (t, u5, u7) => JSON.stringify({ observed_at: T + t, account_fp: fp, tier: 'default_claude_max_5x', source: 'usage_api',
    five_hour: { utilization: u5, resets_at: new Date(T + 5 * 3600000).toISOString() }, seven_day: { utilization: u7, resets_at: new Date(T + 5 * 86400000).toISOString() } });
  fs.writeFileSync(path.join(data, 'samples.jsonl'), [s(-60000, 1, 10), s(30 * 60000, 20, 14), s(65 * 60000, 40, 18)].join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(consent ? { consent_version: 2, consent_v2_at: new Date(T - 3600000).toISOString(), auto_submit: true } : {}));
  return { fp, data };
}

test('submit v2: 동의 없으면 안 보냄, 미리보기엔 금지 필드 없음, 보낸 bin은 다시 안 보내고 내용 바뀌면 다시 보냄', async () => {
  const got = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"status":"accepted"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = sandbox(); seed(a.env.JINSIL_HOME, { consent: false });
    fs.writeFileSync(path.join(a.env.JINSIL_HOME, 'device.json'), JSON.stringify({ server: url, device_token: 'dev_test' }));
    assert.match(await runAsync(['submit'], a.env), /동의 전/);
    assert.equal(got.length, 0);

    const { env } = sandbox(); const { fp, data } = seed(env.JINSIL_HOME);
    fs.writeFileSync(path.join(env.JINSIL_HOME, 'device.json'), JSON.stringify({ server: url, device_token: 'dev_test' }));
    const dry = await runAsync(['submit', '--dry-run'], env);
    assert.match(dry, /서버로 보낼 내용/);
    for (const bad of ['/Users/someone', 'msg_', 'req_', 'secret', os.hostname(), 'dev_test']) assert.ok(!dry.includes(bad), bad);
    await runAsync(['submit'], env);
    assert.equal(got.length, 1);
    const p = got[0].body;
    assert.equal(got[0].url, '/v2/bins'); assert.equal(got[0].auth, 'Bearer dev_test');
    assert.equal(p.account_fp, fp); assert.equal(p.tier, 'default_claude_max_5x'); assert.equal(p.client.collector, 'transcript');
    assert.ok(p.bins.length >= 1 && p.bins.every(b => b.revision && b.model === 'claude-opus-5' && Number.isInteger(b.bin_start)));
    assert.equal(p.samples.length, 6, '샘플 3건 × 게이지 2');
    const wire = JSON.stringify(p);
    for (const bad of ['/Users/someone', 'msg_', 'req_', os.hostname(), 'email']) assert.ok(!wire.includes(bad), bad);
    await runAsync(['submit'], env);
    assert.equal(got.length, 1, '바뀐 것 없으면 안 보냄');
    const st = JSON.parse(fs.readFileSync(path.join(data, 'transcript_state.json'), 'utf8'));
    st.messages['msg_0:req_0'].tokens.output = 999;
    fs.writeFileSync(path.join(data, 'transcript_state.json'), JSON.stringify(st));
    await runAsync(['submit'], env);
    assert.equal(got.length, 2);
    assert.equal(got[1].body.bins.length, 1, '바뀐 bin만'); assert.equal(got[1].body.samples.length, 0);
    const rep = await runAsync(['report'], env);
    assert.match(rep, /5h|7d/);
  } finally { server.close(); }
});

test('로그인은 호스트명 대신 설치 식별자를 보낸다', async () => {
  let body = null;
  const server = http.createServer(async (req, res) => { let b = ''; for await (const c of req) b += c; body = JSON.parse(b); res.writeHead(500); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const { env } = sandbox();
    await runAsync(['login', '--server', `http://127.0.0.1:${server.address().port}`], env).catch(() => {});
    assert.match(body.name, /^pc-[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(body).includes(os.hostname()));
  } finally { server.close(); }
});
