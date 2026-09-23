// 요금제 매핑(서버·CLI 공용). 실측으로 확인된 rate_limit_tier 문자열만 명시 매핑한다.
// 미확인 문자열(Team 포함)은 null = "요금제 미확인" → 통계 제외. 새 문자열은 실측 후 여기에 추가한다.
export const TIER_MAP = {
  default_claude_max_5x: 'max5x',   // 2026-09-23 운영 실측
  default_claude_max_20x: 'max20x', // Anthropic 명명 규칙상 대응(테스트 fixture). 첫 실측 시 확인
  default_claude_pro: 'pro',        // 같은 규칙. 첫 실측 시 확인
};
// Team 좌석은 rate_limit_tier가 개인 요금제와 같은 문자열일 수 있다(09-24 제보: Team Premium인데 Max 5x로 표시).
// 그래서 조직 유형(organization_type)이 Team이면 좌석 등급(seat_tier)으로 가르고, rate_limit_tier는 쓰지 않는다.
// 전송 형식: 개인 = rate_limit_tier 그대로, Team = `team__<seat_tier>`(서버 검증 [a-z0-9_]).
const clean = v => String(v).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48);
export function tierFromProfile(json) {
  const o = json?.organization || {};
  if (typeof o.organization_type === 'string' && /team|enterprise/.test(o.organization_type))
    return `team__${o.seat_tier ? clean(o.seat_tier) : 'unknown'}`;
  return typeof o.rate_limit_tier === 'string' ? o.rate_limit_tier : null;
}
export function planOf(tier) {
  if (typeof tier !== 'string') return null;
  if (tier.startsWith('team__')) return /premium/.test(tier) ? 'team_premium' : /standard/.test(tier) ? 'team_standard' : null; // 좌석 문자열 첫 실측 시 확인
  return Object.hasOwn(TIER_MAP, tier) ? TIER_MAP[tier] : null;
}
export const PLAN_LABEL = { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x', team_standard: 'Team Standard', team_premium: 'Team Premium' };
