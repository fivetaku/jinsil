// 요금제 판별: Team 조직은 rate_limit_tier(개인 요금제와 같은 문자열일 수 있음)가 아니라 좌석 등급으로 가른다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tierFromProfile, planOf } from '../src/tiers.mjs';

test('개인 요금제는 rate_limit_tier, Team은 좌석 등급(모르면 미확인)', () => {
  assert.equal(planOf(tierFromProfile({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' } })), 'max5x');
  const team = tierFromProfile({ organization: { organization_type: 'claude_team', seat_tier: 'team_premium', rate_limit_tier: 'default_claude_max_5x' } });
  assert.match(team, /^[a-z0-9_]{1,64}$/);
  assert.equal(planOf(team), 'team_premium', 'Team Premium이 Max 5x로 잡히지 않음');
  assert.equal(planOf(tierFromProfile({ organization: { organization_type: 'claude_team', seat_tier: 'Standard', rate_limit_tier: 'default_claude_pro' } })), 'team_standard');
  assert.equal(planOf(tierFromProfile({ organization: { organization_type: 'claude_team', seat_tier: null, rate_limit_tier: 'default_claude_max_5x' } })), null);
  assert.equal(tierFromProfile({}), null);
});
