-- 0.2: 5분 bin + 게이지 샘플 수신, 서버가 한도 창 계산(cli/src/window.mjs 공용).
-- 0.1.x intervals·interval_tokens는 0004에서 백업 확인 후 삭제한다(오너 결정 09-23).

ALTER TABLE devices ADD COLUMN install_id TEXT;
ALTER TABLE devices ADD COLUMN collector TEXT;

CREATE TABLE usage_bins (
  account_fp TEXT NOT NULL REFERENCES claude_accounts(account_fp) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  bin_start INTEGER NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, cache_write_unknown INTEGER NOT NULL,
  messages INTEGER NOT NULL, sidechain_messages INTEGER NOT NULL DEFAULT 0,
  special_json TEXT NOT NULL DEFAULT '{}',
  revision TEXT NOT NULL,
  collector TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_fp, device_id, bin_start, model)
);
CREATE INDEX usage_bins_acct_time ON usage_bins (account_fp, bin_start);

CREATE TABLE gauge_samples (
  account_fp TEXT NOT NULL REFERENCES claude_accounts(account_fp) ON DELETE CASCADE,
  gauge TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  utilization REAL NOT NULL,
  resets_at TEXT NOT NULL,
  source TEXT NOT NULL,
  tier TEXT,
  PRIMARY KEY (account_fp, gauge, observed_at, device_id)
);

CREATE TABLE windows (
  window_id TEXT PRIMARY KEY,
  account_fp TEXT NOT NULL REFERENCES claude_accounts(account_fp) ON DELETE CASCADE,
  gauge TEXT NOT NULL, resets_at TEXT NOT NULL, tier TEXT, plan TEXT,
  g_base REAL NOT NULL, t_base INTEGER NOT NULL, g_end REAL NOT NULL, t_end INTEGER NOT NULL, samples INTEGER NOT NULL, delta REAL NOT NULL,
  cost REAL, cost_lo REAL, cost_hi REAL,
  usd_per_pct REAL, usd_per_pct_lo REAL, usd_per_pct_hi REAL,
  stage TEXT, state TEXT NOT NULL, exclude_reason TEXT,
  collectors TEXT, devices INTEGER NOT NULL DEFAULT 1,
  price_version TEXT, calc_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX windows_acct ON windows (account_fp, gauge);

CREATE TABLE price_versions (
  hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source_url TEXT
);

-- 요청 기준 레이트 제한(기기·엔드포인트별 분당 창)
CREATE TABLE request_counts (
  key TEXT NOT NULL,
  minute INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, minute)
);
