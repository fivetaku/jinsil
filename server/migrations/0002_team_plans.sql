-- Team 요금제(미국, 월 결제 기준). 출처: https://support.claude.com/en/articles/9266767-what-is-the-team-plan (2026-09-23 확인)
-- Standard $25/월(연 결제 $20), Premium $125/월(연 결제 $100). 가성비 배수는 월 결제가 기준.
INSERT OR REPLACE INTO plan_prices (plan, monthly_usd, valid_from, source_url, verified_at) VALUES
 ('team_standard', 25, '2026-01-01', 'https://support.claude.com/en/articles/9266767-what-is-the-team-plan', '2026-09-23'),
 ('team_premium', 125, '2026-01-01', 'https://support.claude.com/en/articles/9266767-what-is-the-team-plan', '2026-09-23');
