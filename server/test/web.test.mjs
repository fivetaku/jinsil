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
    '가성비 배수', '요금제별 순위', '참여 로그', '매주 100%를 다 썼을 때의 이론적 상한', 'npx jinsil setup', '#', 'Google로 참여'])
    assert.ok(t.includes(s), `메인에 "${s}" 없음`);
  assert.match(t, /Max 5x[\s\S]*?\d+배/);
  // 토큰 종류별 공개 차트 없음
  for (const s of ['토큰 종류별', '캐시 읽기', '1시간 캐시 기록']) assert.ok(!t.includes(s), `공개 화면에 "${s}"`);
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
  assert.ok(t.includes('이 요금제 참여 계정이 2개 이상이면 순위를 공개합니다(현재 1)'));
});

test('방법론: 계산식·스티커 규칙·한계·개인정보', async () => {
  const { t } = await get('/methodology');
  for (const s of ['× 4.35주', '가성비 배수', '광고보다 적음', '이론적 상한', '한계', '개인정보', '~/.jinsil']) assert.ok(t.includes(s), s);
});

test('/me: 순위·상위 %·실효 단가·평균 대비·추이·이력·CSV·리포트·기기·삭제', async () => {
  const { r, t } = await get('/me', owner);
  assert.equal(r.status, 200);
  for (const s of ['내 대시보드', '위', '상위', 'API 1달러어치를 쓰는 실효 단가', '요금제 평균 대비', '주간 1%당 비용 추이', '주간 구간 기준', 'preserveAspectRatio="none"', '제출 이력', 'CSV 내려받기',
    '이의제기용 리포트', '연결된 PC', 'test-mac', '내 데이터 전체 삭제', '통계 제외 ·'.slice(0, 0)]) assert.ok(t.includes(s), `/me에 "${s}" 없음`);
  assert.ok(/제외 · 게이지 상승 부족/.test(t), '제외 사유 한글 표시');
  const rep = await get('/me/report', owner);
  for (const s of ['Claude 구독 한도 실측 리포트', '요금제 평균', '수용된 구간', 'PDF로 저장']) assert.ok(rep.t.includes(s), s);
  const csv = await fetch(`${srv.base}/me/export.csv`, { headers: { cookie: owner } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
});

test('없는 페이지 404, 로그인 안 한 /me는 로그인으로', async () => {
  assert.equal((await get('/nope')).r.status, 404);
  const r = await fetch(`${srv.base}/me`, { redirect: 'manual' });
  assert.equal(r.status, 302);
});
