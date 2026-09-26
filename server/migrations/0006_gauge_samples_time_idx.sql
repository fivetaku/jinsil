-- 09-26 D1 rows read 한도: 재계산의 `WHERE account_fp = ? AND observed_at > ?`가 PK(account_fp, gauge, observed_at, device_id)로는
-- observed_at 범위를 좁히지 못해 계정 전 샘플을 읽는다. 9일 넘게 쌓이면 효과가 커진다.
CREATE INDEX IF NOT EXISTS gauge_samples_acct_time ON gauge_samples (account_fp, observed_at);
