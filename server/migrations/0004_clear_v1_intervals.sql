-- 0.2 전환: 0.1.x 구간 데이터 삭제(오너 결정 09-23). 적용 전 `wrangler d1 export --remote` 백업 파일 확인 필수.
-- 테이블 정의는 남기고 행만 지운다(0.2 코드는 읽지 않음, /me 삭제 경로만 참조).
DELETE FROM interval_tokens;
DELETE FROM intervals;
DELETE FROM account_stats;
-- 0.1 구간 규칙이 만든 플래그는 창 기준과 무관하므로 지운다(계정 결속 기록은 남긴다).
DELETE FROM flags WHERE rule <> 'account_bound_to_other_user';
-- 0.1 일일 스냅샷은 구간 평균 기준이라 새 창 중앙값과 섞이지 않게 지운다.
DELETE FROM stats_daily;
