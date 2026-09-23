// 화면 검증용 시드: 스티커 5종(가성비 1위·구독료 배수·가격→가치/비교 기준·광고보다 적음·측정 대기)이 모두 나오게.
// MIN_ACCOUNTS=2 서버를 전제. Pro 1계정(측정 대기), Max 5x 3계정(기준·1위), Max 20x 2계정(광고보다 적음).
import { login, linkDevice, interval, post, zero } from './harness.mjs';

export async function seed(base) {
  const owner = await login(base, 'seed-owner');
  const token = (await linkDevice(base, owner)).token.device_token;
  const acc = [
    ['1', 'default_claude_pro', 0.6], ['2', 'default_claude_max_5x', 3], ['3', 'default_claude_max_5x', 3.4], ['4', 'default_claude_max_5x', 2.8],
    ['5', 'default_claude_max_20x', 3.6], ['6', 'default_claude_max_20x', 4.2],
  ];
  let day = 10;
  for (const [c, tier, mtok] of acc) {
    for (let w = 0; w < 2; w++) {
      const r = await post(base, token, interval({ account_fp: c.repeat(60) + 'f00' + c, tier, g_start: w * 3, g_end: w * 3 + 3,
        t_start: `2026-09-${day}T10:00:00.000Z`, t_end: `2026-09-${day}T12:00:00.000Z`,
        tokens_by_model: { 'claude-opus-5-5': { ...zero, input: Math.round(mtok * 1e6), output: 200_000, cache_read: 5_000_000 } } }));
      if (r.body?.status !== 'accepted') throw Error(`seed rejected: ${JSON.stringify(r.body)}`);
      day++;
    }
  }
  // 5시간 구간·제외 구간도 피드에 보이게
  await post(base, token, interval({ account_fp: '2'.repeat(60) + 'f002', gauge: '5h', reset_at: '2030-01-01T05:00:00.000Z', g_start: 10, g_end: 14 }));
  await post(base, token, interval({ account_fp: '3'.repeat(60) + 'f003', gauge: '5h', reset_at: '2030-01-01T05:00:00.000Z', g_start: 20, g_end: 22 }));
  return { owner, token };
}
