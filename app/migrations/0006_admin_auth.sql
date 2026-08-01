-- 4-2B: 관리자 세션 인증 스키마 (테이블만 생성. 엔드포인트는 4-2C)
--
-- 배경: 현행 /admin 과 /api/promo-upload 는 `?key=<ADMIN_KEY>` 쿼리스트링
-- 단일 시크릿을 쓴다. 시크릿이 URL 에 실려 히스토리·Referer·로그에 남고,
-- 만료·개별 회수가 안 되며, 무엇보다 **사용자를 식별할 수 없어 감사 로그의
-- '변경한 관리자'를 채울 수 없다.** 그래서 세션 쿠키 방식으로 옮긴다.
--
-- 승인된 D2(B안) 단서: ADMIN_KEY 는 **세션 교환 경로에서만** 허용한다.
-- 데이터를 바꾸는 API 는 세션만 받는다(ADMIN_KEY 병행 허용 금지).
--
-- 비밀번호는 PBKDF2-SHA256(WebCrypto crypto.subtle, 외부 의존성 0)으로 해싱하고
-- 계정별 salt 를 쓴다. 세션 토큰은 원문을 저장하지 않고 SHA-256 해시만 저장해
-- DB 가 유출돼도 세션을 재사용할 수 없게 한다.
-- 이 마이그레이션에는 계정 INSERT 가 없다. 최초 계정 생성은 4-2C 에서
-- 부트스트랩 시크릿으로 1회 수행한다.

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL,
  pw_hash       TEXT    NOT NULL,
  pw_salt       TEXT    NOT NULL,
  pw_iterations INTEGER NOT NULL DEFAULT 210000,
  role          TEXT    NOT NULL DEFAULT 'admin',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,

  CONSTRAINT ck_admin_users_role     CHECK (role IN ('admin','editor','viewer')),
  CONSTRAINT ck_admin_users_disabled CHECK (disabled IN (0,1)),
  CONSTRAINT ck_admin_users_iter     CHECK (pw_iterations >= 100000),
  CONSTRAINT ck_admin_users_name     CHECK (length(trim(username)) BETWEEN 3 AND 60)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_username
  ON admin_users (lower(username));

-- 세션. user_id 는 admin_users 로 FK 를 걸고 ON DELETE CASCADE 를 둔다 —
-- 계정을 지우면 그 계정의 세션도 즉시 무효가 되어야 한다.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  ua         TEXT,

  CONSTRAINT ck_admin_sessions_revoked CHECK (revoked IN (0,1)),
  CONSTRAINT ck_admin_sessions_hash    CHECK (length(token_hash) = 64),
  CONSTRAINT ck_admin_sessions_expiry  CHECK (length(trim(expires_at)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions (user_id, expires_at DESC);
-- 만료 세션 일괄 정리 · 유효성 검사 경로
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions (expires_at);
-- 살아 있는 세션만 훑는 스윕(부분 인덱스)
CREATE INDEX IF NOT EXISTS idx_admin_sessions_live
  ON admin_sessions (expires_at) WHERE revoked = 0;

-- 로그인 무차별 대입 방어.
--
-- 키는 **IP + 아이디 조합**이다. IP 만으로 잡으면 사무실·모바일망처럼 여러
-- 관리자가 같은 공인 IP 를 쓸 때 한 사람의 오타가 나머지를 잠그고, 반대로
-- 아이디만으로 잡으면 분산 IP 공격을 못 막는다.
--
-- 4-2C 는 이 테이블 하나로 두 층을 강제한다.
--   1) (ip, username) 조합 : 특정 계정 표적 대입
--   2) ip 단위 SUM(count)  : 아이디를 바꿔 가며 훑는 계정 열거
-- 2번을 위해 (ip, window_start) 인덱스를 둔다.
-- username 은 소문자로 정규화해 저장한다(admin_users 유일성 규칙과 동일).
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip           TEXT    NOT NULL,
  username     TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  last_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (ip, username),
  CONSTRAINT ck_login_attempts_count    CHECK (count >= 0),
  CONSTRAINT ck_login_attempts_ip       CHECK (length(trim(ip)) BETWEEN 1 AND 60),
  CONSTRAINT ck_login_attempts_username CHECK (username = lower(username) AND length(username) <= 60),
  CONSTRAINT ck_login_attempts_window   CHECK (window_start >= 0)
);

-- IP 단위 합산 조회(계정 열거 탐지)와 오래된 윈도 정리에 쓴다.
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip
  ON admin_login_attempts (ip, window_start);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_window
  ON admin_login_attempts (window_start);
