// 요금제 매핑(서버·CLI 공용). 실측으로 확인된 rate_limit_tier 문자열만 명시 매핑한다.
// 미확인 문자열(Team 포함)은 null = "요금제 미확인" → 통계 제외. 새 문자열은 실측 후 여기에 추가한다.
export const TIER_MAP = {
  default_claude_max_5x: 'max5x',   // 2026-09-23 운영 실측
  default_claude_max_20x: 'max20x', // Anthropic 명명 규칙상 대응(테스트 fixture). 첫 실측 시 확인
  default_claude_pro: 'pro',        // 같은 규칙. 첫 실측 시 확인
};
export const planOf = tier => (typeof tier === 'string' && Object.hasOwn(TIER_MAP, tier) ? TIER_MAP[tier] : null);
export const PLAN_LABEL = { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x', team_standard: 'Team Standard', team_premium: 'Team Premium' };
