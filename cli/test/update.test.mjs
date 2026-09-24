// 0.2.6: 자동 업데이트 판단, 버전 바뀌면 기록 재전송, 제출에 사용 범위·제외 개수(숫자만).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-up-'));
process.env.JINSIL_HOME = home;
const { verLt, maybeSelfUpdate } = await import('../src/collector.mjs');
const { saveConfig } = await import('../src/config.mjs');

test('버전 비교와 자동 업데이트: 새 버전일 때만 npx jinsil@<v> setup --yes, 끄면 안 함', async () => {
  assert.ok(verLt('0.2.5', '0.2.10')); assert.ok(!verLt('0.2.6', '0.2.6')); assert.ok(!verLt('0.3.0', '0.2.9'));
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  const calls = [];
  const spawnFn = (cmd, args) => { calls.push(args); return { unref() {} }; };
  assert.equal(await maybeSelfUpdate('0.2.6', { latest: async () => '0.2.6', spawnFn }), null);
  assert.equal(await maybeSelfUpdate('0.2.6', { latest: async () => 'evil; rm', spawnFn }), null);
  assert.equal(await maybeSelfUpdate('0.2.6', { latest: async () => '0.2.7', spawnFn }), '0.2.7');
  assert.deepEqual(calls[0], ['-y', 'jinsil@0.2.7', 'setup', '--yes', '--no-login', '--no-path']);
  saveConfig({ auto_update: false });
  assert.equal(await maybeSelfUpdate('0.2.6', { latest: async () => '0.2.8', spawnFn }), null);
  assert.equal(calls.length, 1);
});
