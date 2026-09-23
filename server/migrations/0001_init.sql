-- 클진요 D1 스키마 (PRD 02_DATA_MODEL.md). 이메일·프롬프트·인증값은 저장하지 않는다.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',        -- active | suspended
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT, os TEXT, client_version TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER
);
CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  approved_user_id TEXT, denied INTEGER NOT NULL DEFAULT 0,
  device_meta TEXT NOT NULL
);
CREATE TABLE claude_accounts (
  account_fp TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_latest TEXT,
  public_tag TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);
CREATE TABLE intervals (
  interval_id TEXT PRIMARY KEY,
  account_fp TEXT NOT NULL REFERENCES claude_accounts(account_fp) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  tier TEXT, gauge TEXT NOT NULL, reset_at TEXT,
  g_start INTEGER NOT NULL, g_end INTEGER NOT NULL,
  t_start TEXT NOT NULL, t_end TEXT NOT NULL,
  boundary_json TEXT NOT NULL,
  requests INTEGER NOT NULL,
  quality_json TEXT NOT NULL,
  routed_upstream INTEGER NOT NULL DEFAULT 0,
  client_version TEXT,
  price_version TEXT,
  cost_usd REAL, cost_lo REAL, cost_hi REAL, usd_per_pct REAL,
  status TEXT NOT NULL,                          -- accepted | flagged | excluded
  exclude_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX intervals_account ON intervals(account_fp, gauge, reset_at);
CREATE INDEX intervals_created ON intervals(created_at);
CREATE TABLE interval_tokens (
  interval_id TEXT NOT NULL REFERENCES intervals(interval_id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, cache_write_unknown INTEGER NOT NULL,
  PRIMARY KEY (interval_id, model)
);
CREATE TABLE prices (
  model TEXT NOT NULL, component TEXT NOT NULL, usd_per_mtok REAL NOT NULL,
  valid_from TEXT NOT NULL, source_url TEXT, verified_at TEXT,
  PRIMARY KEY (model, component, valid_from)
);
CREATE TABLE plan_prices (
  plan TEXT NOT NULL, monthly_usd REAL NOT NULL, valid_from TEXT NOT NULL,
  source_url TEXT, verified_at TEXT,
  PRIMARY KEY (plan, valid_from)
);
CREATE TABLE flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interval_id TEXT, account_fp TEXT,
  rule TEXT NOT NULL, detail TEXT, reviewed_by TEXT, decision TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE account_stats (
  account_fp TEXT PRIMARY KEY, tier TEXT, weekly_pct_sum INTEGER, cost_sum REAL,
  usd_per_100pct REAL, value_multiple REAL, effective_usd_per_api_usd REAL,
  rank_in_tier INTEGER, n_in_tier INTEGER, eligible INTEGER, updated_at INTEGER
);
CREATE TABLE stats_daily (
  date TEXT NOT NULL, plan TEXT NOT NULL, gauge TEXT NOT NULL,
  n_accounts INTEGER, n_intervals INTEGER, mean_usd_per_100pct REAL, min REAL, max REAL, p25 REAL, p75 REAL,
  monthly_value_usd REAL, value_multiple REAL, weights_json TEXT,
  PRIMARY KEY (date, plan, gauge)
);

-- 잠정 단가(첨부 자료 2026-09-23). verified_at NULL = 공식 확인 전. 통계는 verified 여부를 화면에 표시한다.
INSERT INTO prices (model, component, usd_per_mtok, valid_from, source_url, verified_at) VALUES
 ('claude-opus-5-5','input',4,'2026-01-01',NULL,NULL),('claude-opus-5-5','output',20,'2026-01-01',NULL,NULL),
 ('claude-opus-5-5','cache_write_5m',5,'2026-01-01',NULL,NULL),('claude-opus-5-5','cache_write_1h',8,'2026-01-01',NULL,NULL),('claude-opus-5-5','cache_read',0.2,'2026-01-01',NULL,NULL),
 ('claude-opus-5','input',5,'2026-01-01',NULL,NULL),('claude-opus-5','output',25,'2026-01-01',NULL,NULL),
 ('claude-opus-5','cache_write_5m',6.25,'2026-01-01',NULL,NULL),('claude-opus-5','cache_write_1h',10,'2026-01-01',NULL,NULL),('claude-opus-5','cache_read',0.5,'2026-01-01',NULL,NULL),
 ('claude-opus-4-8','input',5,'2026-01-01',NULL,NULL),('claude-opus-4-8','output',25,'2026-01-01',NULL,NULL),
 ('claude-opus-4-8','cache_write_5m',6.25,'2026-01-01',NULL,NULL),('claude-opus-4-8','cache_write_1h',10,'2026-01-01',NULL,NULL),('claude-opus-4-8','cache_read',0.5,'2026-01-01',NULL,NULL),
 ('claude-fable-5-1','input',10,'2026-01-01',NULL,NULL),('claude-fable-5-1','output',50,'2026-01-01',NULL,NULL),
 ('claude-fable-5-1','cache_write_5m',12.5,'2026-01-01',NULL,NULL),('claude-fable-5-1','cache_write_1h',20,'2026-01-01',NULL,NULL),('claude-fable-5-1','cache_read',0.25,'2026-01-01',NULL,NULL),
 ('claude-sonnet-5','input',2,'2026-01-01',NULL,NULL),('claude-sonnet-5','output',10,'2026-01-01',NULL,NULL),
 ('claude-sonnet-5','cache_write_5m',2.5,'2026-01-01',NULL,NULL),('claude-sonnet-5','cache_write_1h',4,'2026-01-01',NULL,NULL),('claude-sonnet-5','cache_read',0.2,'2026-01-01',NULL,NULL),
 ('claude-haiku-4-5','input',1,'2026-01-01',NULL,NULL),('claude-haiku-4-5','output',5,'2026-01-01',NULL,NULL),
 ('claude-haiku-4-5','cache_write_5m',1.25,'2026-01-01',NULL,NULL),('claude-haiku-4-5','cache_write_1h',2,'2026-01-01',NULL,NULL),('claude-haiku-4-5','cache_read',0.1,'2026-01-01',NULL,NULL),
 ('claude-haiku-4-5-20251001','input',1,'2026-01-01',NULL,NULL),('claude-haiku-4-5-20251001','output',5,'2026-01-01',NULL,NULL),
 ('claude-haiku-4-5-20251001','cache_write_5m',1.25,'2026-01-01',NULL,NULL),('claude-haiku-4-5-20251001','cache_write_1h',2,'2026-01-01',NULL,NULL),('claude-haiku-4-5-20251001','cache_read',0.1,'2026-01-01',NULL,NULL);
-- 구독료: 미국 정가 USD(사용자 확인 2026-09-23). 세금은 요금제 공통이라 비교에서 제외.
INSERT INTO plan_prices (plan, monthly_usd, valid_from, source_url, verified_at) VALUES
 ('pro',20,'2026-01-01',NULL,'2026-09-23'),('max5x',100,'2026-01-01',NULL,'2026-09-23'),('max20x',200,'2026-01-01',NULL,'2026-09-23');
