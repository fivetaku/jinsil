// 계정 풀(teamclaude) 모드: 풀 설정 → 계정 지문, 로그 증분 읽기(연결 이전·비OAuth·비표준 모델 제외, 쓰는 중 줄 보류), 계정별 게이지(활동 계정만·목적지 고정).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPool, scanPoolLog, createPoolSampler, lastActivityByFp } from '../src/teamclaude.mjs';
import { accountFingerprint } from '../src/recorder.mjs';
import { buildBins } from '../src/bins.mjs';

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-tc-'));
const cfgFile = path.join(d, 'teamclaude.json'), log = path.join(d, 'usage.tsv');
const tok = ['tok', 'A'].join('_'), tokB = ['tok', 'B'].join('_');
fs.writeFileSync(cfgFile, JSON.stringify({ accounts: [
  { name: 'a@x', type: 'oauth', accountUuid: 'uuid-a', accessToken: tok },
  { name: 'b@x', type: 'oauth', accountUuid: 'uuid-b', accessToken: tokB, disabled: true },
  { name: 'relay', type: 'apikey' }] }));
const T = Date.now() - 3600000;
const row = (t, acct, model, i, o, ct, cr) => [T + t, acct, model, i, o, ct, cr, '0.1', '0.2', ''].join('\t');

test('풀 설정: OAuth 계정만, 지문은 다른 모드와 같은 값, 비활성 계정은 토큰 없음', () => {
  const p = readPool(cfgFile);
  assert.equal(p.size, 2);
  assert.equal(p.get('a@x').fp, accountFingerprint('uuid-a'));
  assert.equal(p.get('a@x').token, tok); assert.equal(p.get('b@x').token, null);
  assert.equal(readPool(path.join(d, 'none.json')), null);
  assert.deepEqual([...readPool(cfgFile, ['a@x']).keys()], ['a@x'], '지정한 계정만');
});

test('로그 증분: 연결 이전·비OAuth·비표준 모델 제외, 캐시쓰기=합계−읽기(5분 가정), 쓰는 중인 마지막 줄은 다음에', () => {
  const pool = readPool(cfgFile);
  fs.writeFileSync(log, [row(-7200000, 'a@x', 'claude-opus-5-5', 1, 1, 0, 0), row(0, 'a@x', 'claude-opus-5-5', 4, 0, 1000, 800), row(1000, 'a@x', 'claude-opus-5-5', 0, 50, 0, 0),
    row(2000, 'relay', 'claude-opus-5-5', 9, 9, 0, 0), row(3000, 'b@x', 'claude-ocx-x', 1, 1, 0, 0)].join('\n') + '\n' + row(4000, 'b@x', 'claude-sonnet-5', 2, 2, 0, 0));
  const st = {};
  assert.equal(scanPoolLog(st, { file: log, pool, since: T - 60000 }), 2);
  assert.deepEqual(st.excluded, { not_oauth_account: 1, nonstandard_model: 1 });
  const m = Object.values(st.messages).find(x => x.tokens.cache_read === 800);
  assert.equal(m.tokens.cache_write_5m, 200); assert.equal(m.tokens.cache_write_unknown, 0); assert.equal(m.account_fp, pool.get('a@x').fp);
  fs.appendFileSync(log, '\n');
  assert.equal(scanPoolLog(st, { file: log, pool, since: T - 60000 }), 1, '마지막 줄은 줄바꿈 뒤에 한 번만');
  assert.equal(scanPoolLog(st, { file: log, pool, since: T - 60000 }), 0);
  const bins = buildBins(st.messages, []);
  assert.ok(bins.every(b => b.account_fp), '풀 모드 bin은 계정이 확정됨');
});

test('계정별 게이지: 활동 계정만 조회, 목적지 경로는 profile·usage, 5분 안 재조회 없음, 429 대기', async () => {
  const pool = readPool(cfgFile);
  const calls = []; let clock = T + 10000, status = 200;
  const get = async (p, token) => { calls.push([p, token]); return status === 429 ? { status: 429, retryAfter: 600 }
    : { status: 200, json: p.endsWith('profile') ? { organization: { rate_limit_tier: 'default_claude_max_5x' } } : { five_hour: { utilization: 12, resets_at: new Date(T + 3600000).toISOString() }, seven_day: { utilization: 18, resets_at: new Date(T + 86400000).toISOString() } } }; };
  const s = createPoolSampler({ get, now: () => clock });
  const act = new Map([[pool.get('a@x').fp, T]]);
  const out = await s.tick(pool, act);
  assert.equal(out.length, 1); assert.equal(out[0].tier, 'default_claude_max_5x'); assert.equal(out[0].seven_day.utilization, 18);
  assert.deepEqual(calls.map(c => c[0]), ['/api/oauth/profile', '/api/oauth/usage']);
  assert.ok(calls.every(c => c[1] === tok), '비활성 계정 토큰은 쓰지 않음');
  clock += 60000; assert.equal((await s.tick(pool, act)).length, 0, '5분 안 재조회 없음');
  clock += 5 * 60000; status = 429; assert.equal((await s.tick(pool, act)).length, 0);
  status = 200; clock += 60000; assert.equal((await s.tick(pool, act)).length, 0, 'retry-after 동안 대기');
  clock += 3 * 3600000; assert.equal((await s.tick(pool, act)).length, 0, '활동 끝난 뒤 30분+ 지나면 조회 안 함');
  assert.equal(lastActivityByFp({ messages: { k: { ts: 5, account_fp: 'f' } } }).get('f'), 5);
});
