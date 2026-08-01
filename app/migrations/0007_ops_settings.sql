-- 4-2B1: 운영 설정 (키·값)
--
-- 첫 용도는 `mission_source` 다. 값은 'dynamic' | 'static' 두 가지.
--
--   dynamic (기본) : /mission-data 가 D1 의 게시 미션을 돌려준다.
--                    게시 미션이 0건이면 200 + missions:[] 로,
--                    **정상 빈 상태**임을 source='dynamic' 으로 알린다.
--   static         : /mission-data 가 조회를 아예 하지 않고
--                    200 + source='static' + missions:[] 를 돌려준다.
--                    보드는 코드에 남겨 둔 정적 MISSIONS 상수로 렌더한다.
--
-- 이 전환은 **데이터 변경만으로 즉시 적용된다**. 힉스필드 시크릿은 다음
-- deploy_website 전까지 반영되지 않으므로 시크릿으로는 즉시 전환이 불가능하고,
-- 그래서 킬스위치를 시크릿이 아니라 이 테이블에 둔다.
--
-- 이 마이그레이션에도 INSERT 는 없다. **행이 없으면 'dynamic'** 이 기본이므로
-- 초기 데이터가 필요 없다(preview/prod 공유 DB에 데이터를 심지 않는다).
-- 값 화이트리스트는 범용 키·값 테이블이라 SQL 로 표현하지 않고
-- 검증 계층(missions.ts 의 parseMissionSource)에서 강제한다.

CREATE TABLE IF NOT EXISTS ops_settings (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,

  CONSTRAINT ck_ops_settings_key   CHECK (length(trim(key)) BETWEEN 1 AND 60),
  CONSTRAINT ck_ops_settings_value CHECK (length(value) <= 200)
);
