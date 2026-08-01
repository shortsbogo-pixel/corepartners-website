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

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  ua         TEXT,

  CONSTRAINT ck_admin_sessions_revoked CHECK (revoked IN (0,1)),
  CONSTRAINT ck_admin_sessions_hash    CHECK (length(token_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions (expires_at);

-- 로그인 무차별 대입 방어. 기존 chat_rate 와 같은 고정 윈도 방식.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip           TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT ck_login_attempts_count CHECK (count >= 0)
);
