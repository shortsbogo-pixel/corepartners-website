-- 4-2B: 미션 조건 데이터화 (관리자 입력 기반)
--
-- 이 마이그레이션은 전부 additive 다. D1 은 preview 와 production 이 데이터베이스
-- 하나를 공유하므로(HF_ENV 는 코드만 분리한다) DROP / ALTER ... DROP COLUMN /
-- 파괴적 UPDATE 를 절대 넣지 않는다. 여기서는 새 테이블만 만들고 기존 테이블
-- (applications / chat_rate / chat_logs) 은 건드리지 않는다.
--
-- 이 마이그레이션에는 INSERT 가 없다. 현행 운영 미션의 초기 투입은 4-2D 의
-- 관리자 "초기 데이터 가져오기" 1회용 동작으로 하며, 마이그레이션에 넣지 않는
-- 이유는 preview 배포마다 재실행될 위험 때문이다.
--
-- 시각 규약
--   * start_min / end_min : 자정 기준 분(0~1439). '10:55' -> 655
--   * end_day_offset      : 0 = 당일 종료, 1 = 익일 종료(자정 경과)
--   * publish_from / publish_to : UTC ISO8601 ('2026-08-03T09:00:00Z')
--     문자열 사전순 = 시간순이 되도록 UTC 로만 저장한다. 화면 표시만 KST 로 바꾼다.
--   * day_mask : bit0=일 bit1=월 ... bit6=토 (JS Date#getDay 와 동일 순서)
--                0 = 요일 무관(상시). 예) 월~금 = 62, 토·일 = 65, 매일 = 127

CREATE TABLE IF NOT EXISTS missions (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  -- 같은 미션의 요일 변형(포스트런치 평일/주말, 올빼미 월화/수목금/토일)을 묶는 키.
  -- 보드는 한 group_key 안에서 오늘 해당하는 변형 하나만 표시한다.
  group_key      TEXT    NOT NULL,
  day_mask       INTEGER NOT NULL DEFAULT 0,
  start_min      INTEGER,
  end_min        INTEGER,
  end_day_offset INTEGER NOT NULL DEFAULT 0,
  days_label     TEXT,
  note           TEXT,
  publish_from   TEXT,
  publish_to     TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'draft',
  -- 낙관적 잠금. UPDATE ... WHERE id=? AND version=? 로만 갱신하고,
  -- meta.changes 가 0 이면 다른 관리자가 먼저 고친 것으로 보아 409 로 돌려보낸다.
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by     TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by     TEXT,

  CONSTRAINT ck_missions_type   CHECK (type   IN ('regular','weekly','adhoc','night','notice')),
  CONSTRAINT ck_missions_status CHECK (status IN ('draft','published','ended','archived')),
  CONSTRAINT ck_missions_active CHECK (active IN (0,1)),
  CONSTRAINT ck_missions_version CHECK (version >= 1),
  CONSTRAINT ck_missions_sort   CHECK (sort_order >= 0),
  CONSTRAINT ck_missions_name   CHECK (length(trim(name)) BETWEEN 1 AND 40),
  CONSTRAINT ck_missions_group  CHECK (length(trim(group_key)) BETWEEN 1 AND 60),
  CONSTRAINT ck_missions_note   CHECK (note IS NULL OR length(note) <= 200),

  CONSTRAINT ck_missions_daymask CHECK (day_mask BETWEEN 0 AND 127),
  CONSTRAINT ck_missions_offset  CHECK (end_day_offset IN (0,1)),
  CONSTRAINT ck_missions_start   CHECK (start_min IS NULL OR (start_min BETWEEN 0 AND 1439)),
  CONSTRAINT ck_missions_end     CHECK (end_min   IS NULL OR (end_min   BETWEEN 0 AND 1439)),

  -- 시간은 둘 다 있거나 둘 다 없다(시간 무관 미션 = 둘 다 NULL)
  CONSTRAINT ck_missions_time_pair
    CHECK ((start_min IS NULL) = (end_min IS NULL)),
  -- 시간 무관 미션에는 자정 경과가 있을 수 없다
  CONSTRAINT ck_missions_offset_needs_time
    CHECK (start_min IS NOT NULL OR end_day_offset = 0),
  -- 당일 종료면 종료 > 시작 (역전 입력 차단)
  CONSTRAINT ck_missions_same_day_order
    CHECK (start_min IS NULL OR end_day_offset = 1 OR end_min > start_min),
  -- 자정 경과면 종료 < 시작 (같으면 24시간이 되므로 금지)
  CONSTRAINT ck_missions_cross_day_order
    CHECK (start_min IS NULL OR end_day_offset = 0 OR end_min < start_min),
  -- 시간 지정 미션은 요일이 하나 이상 있어야 한다
  CONSTRAINT ck_missions_timed_needs_day
    CHECK (start_min IS NULL OR day_mask > 0),

  CONSTRAINT ck_missions_publish_order
    CHECK (publish_from IS NULL OR publish_to IS NULL OR publish_to >= publish_from)
);

-- 공개 조회(/mission-data)가 타는 경로
CREATE INDEX IF NOT EXISTS idx_missions_public
  ON missions (status, active, sort_order, id);
-- 관리자 목록 · 변형 묶음 조회
CREATE INDEX IF NOT EXISTS idx_missions_group
  ON missions (group_key, sort_order);
CREATE INDEX IF NOT EXISTS idx_missions_publish
  ON missions (publish_to);

-- 완전히 같은 변형(같은 묶음 · 같은 요일 · 같은 시간)을 두 번 만들지 못하게 한다.
-- archived 는 기록 보존용이므로 제외해 과거 이력과 충돌하지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_missions_variant
  ON missions (group_key, day_mask, ifnull(start_min,-1), ifnull(end_min,-1), end_day_offset)
  WHERE status <> 'archived';

-- 보상 티어 1~4단. 공지형(type='notice')은 0단을 허용하므로
-- "티어가 하나 이상"은 SQL 이 아니라 검증 계층(missions.ts)에서 판정한다.
CREATE TABLE IF NOT EXISTS mission_tiers (
  id            TEXT    PRIMARY KEY,
  mission_id    TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE ON UPDATE CASCADE,
  target_count  INTEGER NOT NULL,
  reward_amount INTEGER NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT ck_tiers_count  CHECK (target_count > 0 AND target_count <= 100000),
  CONSTRAINT ck_tiers_reward CHECK (reward_amount >= 0 AND reward_amount <= 100000000),
  CONSTRAINT ck_tiers_slot   CHECK (sort_order BETWEEN 0 AND 3)
);

-- 슬롯 중복 금지(= 최대 4단) + 같은 미션 안에서 목표 건수 중복 금지
CREATE UNIQUE INDEX IF NOT EXISTS uq_mission_tiers_slot
  ON mission_tiers (mission_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mission_tiers_count
  ON mission_tiers (mission_id, target_count);

-- 변경 이력. mission_id 에 외래키를 걸지 않는 것은 의도된 설계다 —
-- 미션이 보관(archive)되거나 어떤 이유로 사라져도 이력은 남아야 하고,
-- ON DELETE CASCADE 가 이력을 지우는 사고를 원천 차단한다.
CREATE TABLE IF NOT EXISTS mission_audit (
  id           TEXT    PRIMARY KEY,
  mission_id   TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  actor        TEXT    NOT NULL,
  from_version INTEGER,
  to_version   INTEGER,
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),

  CONSTRAINT ck_audit_action CHECK (action IN ('create','update','publish','end','archive','restore','import')),
  CONSTRAINT ck_audit_actor  CHECK (length(trim(actor)) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS idx_mission_audit_mission
  ON mission_audit (mission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_audit_time
  ON mission_audit (created_at DESC);
