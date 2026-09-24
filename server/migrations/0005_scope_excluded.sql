-- 0.2.6: 계정 사용 범위(전용/혼용, 참여자 자기 신고)와 기기별 집계 제외 개수(숫자만).
ALTER TABLE claude_accounts ADD COLUMN usage_scope TEXT;
ALTER TABLE devices ADD COLUMN excluded_json TEXT;
