// 남은 writer.lock 정리: 죽은 PID면 정리 후 획득, 살아 있는 PID면 기존대로 실패(이슈 #1-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock } from '../src/recorder.mjs';

test('죽은 PID의 잠금은 정리하고, 살아 있는 PID의 잠금은 그대로 실패', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-lock-'));
  const LOCK = path.join(d, 'writer.lock');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(LOCK, JSON.stringify({ pid: dead, started_ms: 1 }));
  const fd = acquireLock(LOCK);
  assert.ok(Number.isInteger(fd));
  fs.closeSync(fd);
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: live.pid, started_ms: 1 }));
    assert.throws(() => acquireLock(LOCK), e => e.code === 'EEXIST');
  } finally { live.kill(); }
  fs.writeFileSync(LOCK, 'garbage');
  fs.closeSync(acquireLock(LOCK)); // 읽을 수 없는 잠금도 정리
});
