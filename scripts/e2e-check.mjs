#!/usr/bin/env node
// M4 E2E 결과 검증: 최신 docs/e2e-*.md의 JSON 블록이 완료 조건을 만족하는지.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^e2e-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : [];
const fail = m => { console.error(`e2e:check 실패 — ${m}`); process.exit(1); };
if (!files.length) fail('docs/e2e-*.md 없음');
const text = fs.readFileSync(path.join(dir, files.at(-1)), 'utf8');
const r = JSON.parse(/```json\n([\s\S]+?)\n```/.exec(text)?.[1] || 'null');
if (!r) fail('JSON 블록 없음');
const checks = [
  ['오류 없이 종료', !r.error],
  ['실제 upstream', r.upstream === 'api.anthropic.com'],
  ['npx setup 성공', r.setup_exit === 0],
  ['실제 Claude Code 실행 1회 이상', r.runs >= 1],
  ['5시간 3%p 이상 구간 형성', (r.ledger?.intervals || []).some(i => i.gauge === '5h' && +i.g.split('→')[1] - +i.g.split('→')[0] >= 3)],
  ['자동 제출로 피드 반영', r.auto_submitted === true && r.feed.length >= 1],
  ['수용된 제출 1건 이상', r.accepted >= 1],
  ['/me 반영', (r.me || []).length >= 1],
  ['메인에 익명 태그 표시', r.home_shows_tag === true],
  ['거부: 겹침 409', r.rejections?.find(x => x.rule === 'overlapping_interval')?.http === 409],
  ['거부: 다른 사용자 409', r.rejections?.find(x => x.rule === 'account_bound_to_other_user')?.http === 409],
  ['거부: 폐기 기기 401', r.rejections?.find(x => x.rule === 'revoked_device')?.http === 401],
  ['로컬 장부에 인증값·본문 없음', Array.isArray(r.privacy_hits_local) && r.privacy_hits_local.length === 0],
  ['서버 D1에 인증값·본문 없음', Array.isArray(r.privacy_hits_server_d1) && r.privacy_hits_server_d1.length === 0],
  ['기록기 쓰기 실패 0', r.recorder_health_after?.write_failures === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? '✔' : '✖'} ${name}`);
if (checks.some(([, ok]) => !ok)) fail(`${checks.filter(([, ok]) => !ok).length}개 조건 불충족 (${files.at(-1)})`);
console.log(`e2e:check 통과 (${files.at(-1)})`);
