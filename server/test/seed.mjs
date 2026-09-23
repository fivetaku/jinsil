// 화면 검증용 시드(v2 창): 스티커 5종(가성비 1위·구독료 배수·가격→가치/비교 기준·광고보다 적음·측정 대기)이 모두 나오게.
// MIN_ACCOUNTS=2 서버를 전제. Pro 1계정(측정 대기), Max 5x 3계정(기준·1위), Max 20x 2계정(광고보다 적음). 5시간 창·제외 창도 포함.
import { login, linkDevice, windowPayload, postBins } from './harness.mjs';

export async function seed(base) {
  const owner = await login(base, 'seed-owner');
  const token = (await linkDevice(base, owner, { name: 'pc-seed-0001' })).token.device_token;
  const acc = [['1', 'default_claude_pro', 0.6], ['2', 'default_claude_max_5x', 3], ['3', 'default_claude_max_5x', 3.4], ['4', 'default_claude_max_5x', 2.8],
    ['5', 'default_claude_max_20x', 3.6], ['6', 'default_claude_max_20x', 4.2]];
  for (const [c, tier, mtok] of acc) {
    const r = await postBins(base, token, windowPayload({ fp: c.repeat(60) + 'f00' + c, tier, mtok }));
    if (r.status !== 201) throw Error(`seed rejected: ${JSON.stringify(r.body)}`);
  }
  await postBins(base, token, windowPayload({ fp: '2'.repeat(60) + 'f002', gauge: '5h', g0: 10, delta: 20, start: Date.now() - 3 * 3600000 }));
  await postBins(base, token, windowPayload({ fp: '3'.repeat(60) + 'f003', gauge: '5h', g0: 20, delta: 15, external: true, start: Date.now() - 3 * 3600000 }));
  return { owner, token };
}
