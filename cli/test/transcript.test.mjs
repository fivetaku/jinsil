// 대화 파일 파서: 반복 id·usage 갱신·잘린 줄·파일 교체·재시작·라우터/비직결 제외·iterations 비합산·연결 이전 제외.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, parseLine } from '../src/transcript.mjs';
import { buildBins, accountAt } from '../src/bins.mjs';

const T = Date.parse('2026-09-24T01:00:00Z');
const line = (o = {}) => JSON.stringify({
  type: 'assistant', requestId: 'req_' + (o.req || 'A'), timestamp: new Date(o.ts ?? T).toISOString(), isSidechain: !!o.side,
  message: { id: o.id || 'msg_1', model: o.model || 'claude-opus-5', content: [{ type: 'text', text: 'SECRET BODY' }],
    usage: { input_tokens: o.input ?? 10, output_tokens: o.output ?? 5, cache_read_input_tokens: 100, cache_creation_input_tokens: o.cw ?? 20,
      cache_creation: o.noCC ? undefined : { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 },
      iterations: [{ input_tokens: 10, output_tokens: 5 }], speed: o.speed || 'standard', server_tool_use: { web_search_requests: o.ws || 0 } } },
  ...(o.noReq ? { requestId: undefined } : {}),
}) + '\n';

function dir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-tx-')); fs.mkdirSync(path.join(d, 'proj', 'sub'), { recursive: true }); return d; }

test('같은 message.id 반복 줄은 한 번만, 나중 usage로 교체, iterations는 더하지 않는다', () => {
  const d = dir(); const f = path.join(d, 'proj', 's.jsonl');
  fs.writeFileSync(f, line({ output: 5 }) + line({ output: 5, ts: T + 500 }) + line({ output: 9, ts: T + 900 }));
  const st = {};
  scan(st, { root: d, now: T + 1000 });
  const ms = Object.values(st.messages);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].tokens.output, 9);
  assert.equal(ms[0].tokens.input, 10, 'iterations 합산 안 함');
  assert.deepEqual(ms[0].tokens, { input: 10, output: 9, cache_read: 100, cache_write_5m: 20, cache_write_1h: 0, cache_write_unknown: 0 });
  assert.ok(!JSON.stringify(st.messages).includes('SECRET'), '본문을 저장하지 않음');
});

test('잘린 마지막 줄은 다음 스캔에서 읽고, 재시작(상태 재사용)해도 중복 없음, 파일 교체도 중복 없음', () => {
  const d = dir(); const f = path.join(d, 'proj', 'sub', 's.jsonl');
  const full = line({ id: 'm1' }) + line({ id: 'm2', ts: T + 60000 });
  fs.writeFileSync(f, full.slice(0, full.length - 30));
  const st = {};
  scan(st, { root: d, now: T + 1e6 });
  assert.deepEqual(Object.keys(st.messages).map(k => k.split(':')[0]), ['m1']);
  fs.writeFileSync(f, full);
  const again = JSON.parse(JSON.stringify(st)); // 재시작: 디스크에서 읽은 상태
  scan(again, { root: d, now: T + 1e6 });
  assert.equal(Object.keys(again.messages).length, 2);
  scan(again, { root: d, now: T + 1e6 });
  assert.equal(Object.keys(again.messages).length, 2);
  fs.rmSync(f); fs.writeFileSync(f, full); // 새 inode
  scan(again, { root: d, now: T + 1e6 });
  assert.equal(Object.keys(again.messages).length, 2, '파일 교체 후 다시 읽어도 중복 없음');
});

test('라우터(비표준 모델)·requestId 없는 응답·synthetic은 제외하고 개수만 센다, 연결 이전 메시지도 제외', () => {
  assert.equal(parseLine(line({ model: 'claude-ocx-teamclaude--claude-opus-5-5' })).excluded, 'nonstandard_model');
  assert.equal(parseLine(line({ noReq: true })).excluded, 'no_direct_request_id');
  assert.equal(parseLine(line({ model: '<synthetic>' })).excluded, 'synthetic_or_error');
  const d = dir(); const f = path.join(d, 'proj', 's.jsonl');
  fs.writeFileSync(f, line({ id: 'old', ts: T - 3600000 }) + line({ id: 'new', ts: T + 1000 }) + line({ id: 'r', model: 'claude-ocx-x' }));
  fs.utimesSync(f, new Date(T + 5000), new Date(T + 5000));
  const st = {};
  scan(st, { root: d, since: T, now: T + 5000 });
  assert.deepEqual(Object.values(st.messages).map(m => m.key.split(':')[0]), ['new']);
  assert.equal(st.excluded.before_connect, 1);
  assert.equal(st.excluded.nonstandard_model, 1);
});

test('5m/1h 내역이 없으면 캐시 쓰기는 unknown(추정 금지), fast·웹 검색은 special로 표시', () => {
  const m = parseLine(line({ noCC: true, cw: 50, speed: 'fast', ws: 2 }));
  assert.equal(m.tokens.cache_write_unknown, 50);
  assert.equal(m.tokens.cache_write_5m, 0);
  assert.deepEqual(m.special, { nonstandard_speed: 1, web_search_requests: 2 });
});

test('bin: 앞뒤 샘플 계정이 같을 때만 계정 확정, 다르면 미확정', () => {
  const s = (t, fp) => ({ observed_at: t, account_fp: fp, tier: 'default_claude_max_5x' });
  assert.equal(accountAt(T, [s(T - 60000, 'a'), s(T + 60000, 'a')]).account_fp, 'a');
  assert.equal(accountAt(T, [s(T - 60000, 'a'), s(T + 60000, 'b')]), null);
  assert.equal(accountAt(T, [s(T - 3 * 3600000, 'a')]), null, '30분 안에 샘플 없음');
  const msgs = { x: { key: 'x', ts: T + 10000, model: 'claude-opus-5', tokens: { input: 1, output: 2 }, special: {} },
    y: { key: 'y', ts: T + 20000, model: 'claude-opus-5', tokens: { input: 3, output: 4 }, special: {} } };
  const bins = buildBins(msgs, [s(T, 'a')]);
  assert.equal(bins.length, 1);
  assert.equal(bins[0].input, 4); assert.equal(bins[0].messages, 2); assert.equal(bins[0].account_fp, 'a');
});
