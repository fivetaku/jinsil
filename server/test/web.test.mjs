// 웹 페이지 내용 검증: 캠페인형 메인·스티커 5종·순위·참여 로그·/me·방법론·리포트·보안 헤더.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.mjs';
import { seed } from './seed.mjs';

let srv, owner;
before(async () => { srv = await startServer(); ({ owner } = await seed(srv.base)); });
after(async () => { await srv?.stop(); });
const get = async (p, cookie) => { const r = await fetch(`${srv.base}${p}`, { headers: cookie ? { cookie } : {} }); return { r, t: await r.text() }; };

test('메인: 슬로건 띠·요금제 카드·스티커 5종·가성비 막대·순위·참여 로그·이론적 상한 표기', async () => {
  const { r, t } = await get('/');
  assert.equal(r.status, 200);
  for (const s of ['클로드에게 진실을 요구합니다', '구독료', '가성비 1위', '구독료의', '비교 기준', '가격 2배 → 가치', '광고보다 적음', '측정 대기 · 통계 반영 1/2',
    '가성비 배수', '요금제별 순위', '참여 로그', '매주 100%를 다 썼을 때의 이론적 상한', 'npx jinsil setup', '#', 'Google로 참여',
    '참여자가 로컬에서 관측', '보조 지표 · 토큰 종류별 게이지 가중치', '측정 대기 — 첫 계산', 'setup --teamclaude', '증거 묶음(JSON)', '측정 범위', '정밀', '통계에서 뺀 창', '외부 사용 의심', '+5%p 잠정'])
    assert.ok(t.includes(s), `메인에 "${s}" 없음`);
  assert.match(t, /Max 5x[\s\S]*?\d+배/);
  // 계정 지문 전체 비공개
  assert.ok(!t.includes('2'.repeat(60)));
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('순위: 요금제별 내림차순, 익명 태그', async () => {
  const s = await (await fetch(`${srv.base}/api/stats`)).json();
  const m5 = s.ranking.max5x;
  assert.equal(m5.length, 3);
  assert.deepEqual(m5.map(r => r.rank), [1, 2, 3]);
  assert.ok(m5[0].value_multiple >= m5[1].value_multiple && m5[1].value_multiple >= m5[2].value_multiple);
  assert.ok(m5.every(r => /^[0-9a-f]{4}$/.test(r.tag)));
  // 공개 기준 미달(Pro 1/2) 요금제는 순위도 비공개
  assert.deepEqual(s.ranking.pro, []);
  const { t } = await get('/');
  assert.ok(t.includes('이 요금제 계정이 2개 이상 모이면 순위를 공개합니다(현재 1)'));
});

test('방법론: 계산식·스티커 규칙·한계·개인정보', async () => {
  const { t } = await get('/methodology');
  for (const s of ['30일 환산', '가성비 배수', '한도 창', 'C⁻', '잠정', '정밀', '외부 사용 의심', '가중치', '상대 가중치', '반영 지연', '--proxy', '--teamclaude', '이론적 상한', '한계', '개인정보', 'api.anthropic.com']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('4.35'));
});

test('/me: 순위·상위 %·실효 단가·평균 대비·추이·이력·CSV·리포트·기기·삭제', async () => {
  const { r, t } = await get('/me', owner);
  assert.equal(r.status, 200);
  for (const s of ['내 대시보드', '위', '상위', 'API 1달러어치를 쓰는 실효 단가', '요금제 중앙값 대비', '주간 100% 환산 추이', '한도 창', '범위', 'CSV 내려받기',
    '이의제기용 리포트', '연결된 PC', 'pc-seed-0001', '대화 파일', '내 데이터 전체 삭제', '정밀 · ']) assert.ok(t.includes(s), `/me에 "${s}" 없음`);
  assert.ok(/제외 · 외부 사용 의심/.test(t), '제외 사유 한글 표시');
  const rep = await get('/me/report', owner);
  for (const s of ['Claude 구독 한도 실측 리포트', '요금제 중앙값', '집계에 쓴 한도 창', 'PDF로 저장', '가격 버전']) assert.ok(rep.t.includes(s), s);
  const csv = await fetch(`${srv.base}/me/export.csv`, { headers: { cookie: owner } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
});

test('없는 페이지 404, 로그인 안 한 /me는 로그인으로', async () => {
  assert.equal((await get('/nope')).r.status, 404);
  const r = await fetch(`${srv.base}/me`, { redirect: 'manual' });
  assert.equal(r.status, 302);
});
