// 관리자 인증 D1 접근 계층. 규칙은 전부 ./admin-auth 에 있고 여기는 저장소
// 접근과 요청 단위 조립만 한다(missions.ts ↔ missions.server.ts 와 같은 구조).
//
// 읽기까지 전부 'first-primary' 세션을 쓰는 이유: D1 은 read replica 를 둘 수
// 있어 로그인 직후 다른 요청이 replica 를 읽으면 방금 만든 세션 행이 아직
// 없을 수 있다. 그러면 로그인하자마자 401 이 난다. 인증 경로는 지연보다
// 정확성이 중요하므로 primary 를 읽는다.
import type { D1Database } from "@cloudflare/workers-types";
import { bindings } from "./bindings.server";
import {
  ADMIN_ROLES,
  SESSION_TTL_MIN,
  burnPasswordTime,
  classifySession,
  clientIpFrom,
  constantTimeEqual,
  evaluateLoginThrottle,
  generateSessionToken,
  hashSessionToken,
  makePasswordRecord,
  normalizeUsername,
  parseRole,
  passwordIssues,
  readSessionToken,
  sessionExpiryIso,
  shouldRenewSession,
  throttleUsernameKey,
  usernameIssues,
  verifyPassword,
  windowStartFor,
  type AdminRole,
  type AdminUser,
  type ThrottleResult,
} from "./admin-auth";

// ─────────────────────────────────────────────────────────────
// 행 타입
// ─────────────────────────────────────────────────────────────

interface AdminUserRow {
  id: string;
  username: string;
  pw_hash: string;
  pw_salt: string;
  pw_iterations: number;
  role: string;
  disabled: number;
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  revoked: number;
  username: string;
  role: string;
  disabled: number;
}

function toUser(row: { id: string; username: string; role: string }): AdminUser {
  return { id: row.id, username: row.username, role: parseRole(row.role) };
}

const USER_SELECT = `
  SELECT id, username, pw_hash, pw_salt, pw_iterations, role, disabled
    FROM admin_users
   WHERE lower(username) = ?1
`;

const SESSION_SELECT = `
  SELECT s.token_hash, s.user_id, s.expires_at, s.revoked,
         u.username, u.role, u.disabled
    FROM admin_sessions s
    JOIN admin_users u ON u.id = s.user_id
   WHERE s.token_hash = ?1
`;

const SESSION_INSERT = `
  INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at, revoked, ip, ua)
  VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
`;

const SESSION_REVOKE = `UPDATE admin_sessions SET revoked = 1 WHERE token_hash = ?1`;

const SESSION_RENEW = `
  UPDATE admin_sessions SET expires_at = ?2 WHERE token_hash = ?1 AND revoked = 0
`;

/** 만료 스윕. idx_admin_sessions_expiry 를 탄다. */
const SESSION_SWEEP = `DELETE FROM admin_sessions WHERE expires_at < ?1`;

/**
 * 실패 집계. 창이 넘어갔으면 이어 세지 않고 1 로 되돌린다
 * (고정 창 — window_start 가 창의 식별자다).
 */
const ATTEMPT_UPSERT = `
  INSERT INTO admin_login_attempts (ip, username, window_start, count, last_at)
  VALUES (?1, ?2, ?3, 1, ?4)
  ON CONFLICT(ip, username) DO UPDATE SET
    count = CASE WHEN admin_login_attempts.window_start = ?3
                 THEN admin_login_attempts.count + 1 ELSE 1 END,
    window_start = ?3,
    last_at = ?4
`;

const ATTEMPT_CLEAR = `DELETE FROM admin_login_attempts WHERE ip = ?1 AND username = ?2`;
const ATTEMPT_SWEEP = `DELETE FROM admin_login_attempts WHERE window_start < ?1`;

/**
 * 두 층을 한 번에 읽는다. combo 는 (ip, username) 조합, ip_total 은 같은 IP 의
 * 모든 아이디 합(계정 열거 탐지). 지난 창의 행은 0 으로 취급해야 하므로
 * window_start 를 조건에 넣는다.
 */
const ATTEMPT_SELECT = `
  SELECT
    COALESCE((SELECT count FROM admin_login_attempts
               WHERE ip = ?1 AND username = ?2 AND window_start = ?3), 0) AS combo,
    COALESCE((SELECT SUM(count) FROM admin_login_attempts
               WHERE ip = ?1 AND window_start = ?3), 0) AS ip_total
`;

const USER_TOUCH_LOGIN = `UPDATE admin_users SET last_login_at = ?2 WHERE id = ?1`;
const USER_COUNT = `SELECT COUNT(*) AS c FROM admin_users`;
const USER_INSERT = `
  INSERT INTO admin_users (id, username, pw_hash, pw_salt, pw_iterations, role, disabled, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
`;

function primary(db: D1Database) {
  return db.withSession("first-primary");
}

// ─────────────────────────────────────────────────────────────
// 요청에서 읽는 값
// ─────────────────────────────────────────────────────────────

export function clientIp(request: Request): string {
  return clientIpFrom({
    cfConnectingIp: request.headers.get("CF-Connecting-IP"),
    forwardedFor: request.headers.get("X-Forwarded-For"),
  });
}

function userAgent(request: Request): string {
  return (request.headers.get("User-Agent") ?? "").slice(0, 200);
}

// ─────────────────────────────────────────────────────────────
// 세션 검증 — 쓰기 API 가 매 요청 호출한다
// ─────────────────────────────────────────────────────────────

export type AdminAuthFailure =
  | "no_session"
  | "session_expired"
  | "session_revoked"
  | "user_disabled"
  | "db_unavailable";

export type AdminAuthResult =
  | {
      ok: true;
      user: AdminUser;
      /** 쿠키에서 읽은 원문 토큰. 만료를 연장했을 때 쿠키를 다시 굽는 데 쓴다. */
      token: string;
      tokenHash: string;
      expiresAt: string;
      renewedTo: string | null;
    }
  | { ok: false; status: 401 | 503; error: AdminAuthFailure };

/**
 * 쿠키의 세션을 검증한다. 만료가 가까우면 연장하고 연장된 시각을 돌려준다
 * (라우트가 쿠키 Max-Age 를 함께 갱신할 수 있도록). 요청마다 UPDATE 를 치지
 * 않기 위해 임계는 shouldRenewSession 이 정한다.
 */
export async function authenticateAdmin(
  request: Request,
  nowIso: string = new Date().toISOString(),
): Promise<AdminAuthResult> {
  const db = bindings().DB;
  if (!db) return { ok: false, status: 503, error: "db_unavailable" };

  const token = readSessionToken(request.headers.get("Cookie"));
  if (!token) return { ok: false, status: 401, error: "no_session" };

  const tokenHash = await hashSessionToken(token);

  let row: SessionRow | null;
  try {
    row = await primary(db).prepare(SESSION_SELECT).bind(tokenHash).first<SessionRow>();
  } catch (e) {
    console.error("admin session lookup failed", e);
    return { ok: false, status: 503, error: "db_unavailable" };
  }
  if (!row) return { ok: false, status: 401, error: "no_session" };

  const state = classifySession({ revoked: row.revoked, expiresAt: row.expires_at }, nowIso);
  if (state === "revoked") return { ok: false, status: 401, error: "session_revoked" };
  if (state === "expired") return { ok: false, status: 401, error: "session_expired" };
  // 계정이 잠긴 뒤에도 이미 발급된 세션이 살아 있으면 안 된다.
  if (row.disabled === 1) return { ok: false, status: 401, error: "user_disabled" };

  let renewedTo: string | null = null;
  if (shouldRenewSession(row.expires_at, nowIso)) {
    const next = sessionExpiryIso(nowIso, SESSION_TTL_MIN);
    try {
      await db.prepare(SESSION_RENEW).bind(tokenHash, next).run();
      renewedTo = next;
    } catch (e) {
      // 연장 실패는 인증 실패가 아니다. 기존 만료까지는 그대로 유효하다.
      console.error("admin session renew failed", e);
    }
  }

  return {
    ok: true,
    user: toUser({ id: row.user_id, username: row.username, role: row.role }),
    token,
    tokenHash,
    expiresAt: renewedTo ?? row.expires_at,
    renewedTo,
  };
}

// ─────────────────────────────────────────────────────────────
// 로그인
// ─────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; user: AdminUser; token: string; expiresAt: string }
  | { ok: false; status: 400 | 401 | 429 | 503; error: string; retryAfterSec?: number };

async function readThrottle(
  db: D1Database,
  ip: string,
  username: string,
  windowStart: number,
  nowMs: number,
): Promise<ThrottleResult> {
  const row = await primary(db)
    .prepare(ATTEMPT_SELECT)
    .bind(ip, username, windowStart)
    .first<{ combo: number; ip_total: number }>();
  return evaluateLoginThrottle({
    comboFailures: Number(row?.combo ?? 0),
    ipFailures: Number(row?.ip_total ?? 0),
    nowMs,
  });
}

/**
 * 실패는 **아이디가 있든 없든** 똑같이 집계한다. 없는 아이디만 집계에서 빠지면
 * 그 차이로 계정 존재를 알아낼 수 있고, 존재하지 않는 아이디를 끝없이 시도할
 * 길이 열린다.
 */
async function recordFailure(
  db: D1Database,
  ip: string,
  username: string,
  windowStart: number,
  nowIso: string,
): Promise<void> {
  try {
    await db.prepare(ATTEMPT_UPSERT).bind(ip, username, windowStart, nowIso).run();
  } catch (e) {
    console.error("login attempt record failed", e);
  }
}

export async function performAdminLogin(input: {
  request: Request;
  username: unknown;
  password: unknown;
  nowIso?: string;
}): Promise<LoginResult> {
  const db = bindings().DB;
  if (!db) return { ok: false, status: 503, error: "db_unavailable" };

  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const username = normalizeUsername(input.username);
  const password = String(input.password ?? "");
  const ip = clientIp(input.request);
  const windowStart = windowStartFor(nowMs);
  // 집계 키는 조회와 기록이 반드시 같아야 한다 — 한쪽만 자르면 세는 칸과
  // 읽는 칸이 갈라져 잠금이 영영 걸리지 않는다.
  const attemptKey = throttleUsernameKey(username);

  // 아이디·비밀번호가 비어 있어도 잠금 집계에는 넣는다(빈 값 반복 시도 차단).
  if (!username || !password) {
    await recordFailure(db, ip, attemptKey, windowStart, nowIso);
    return { ok: false, status: 400, error: "missing_credentials" };
  }

  let throttle: ThrottleResult;
  try {
    throttle = await readThrottle(db, ip, attemptKey, windowStart, nowMs);
  } catch (e) {
    // 집계를 못 읽으면 **잠긴 것으로 본다**(fail-closed). 여기서 통과시키면
    // 테이블 장애 한 번이 무차별 대입 방어를 통째로 꺼 버린다.
    console.error("login throttle read failed", e);
    return { ok: false, status: 503, error: "db_unavailable" };
  }
  if (!throttle.allowed)
    return {
      ok: false,
      status: 429,
      error: "too_many_attempts",
      retryAfterSec: throttle.retryAfterSec,
    };

  let row: AdminUserRow | null;
  try {
    row = await primary(db).prepare(USER_SELECT).bind(username).first<AdminUserRow>();
  } catch (e) {
    console.error("admin user lookup failed", e);
    return { ok: false, status: 503, error: "db_unavailable" };
  }

  // 없는 아이디·잠긴 계정·틀린 비밀번호는 **전부 같은 응답**이다.
  // 없는 아이디일 때도 같은 시간을 쓰도록 더미 해싱을 돌린다.
  if (!row || row.disabled === 1) {
    await burnPasswordTime(password);
    await recordFailure(db, ip, attemptKey, windowStart, nowIso);
    return { ok: false, status: 401, error: "invalid_credentials" };
  }

  const okPw = await verifyPassword(password, {
    pwHash: row.pw_hash,
    pwSalt: row.pw_salt,
    pwIterations: row.pw_iterations,
  });
  if (!okPw) {
    await recordFailure(db, ip, attemptKey, windowStart, nowIso);
    return { ok: false, status: 401, error: "invalid_credentials" };
  }

  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresAt = sessionExpiryIso(nowIso, SESSION_TTL_MIN);

  try {
    // 한 batch = 한 트랜잭션. 세션 발급과 실패 집계 삭제가 갈라지지 않는다.
    // 스윕을 여기 끼워 넣는 이유는 관리자 로그인이 만료 정리를 돌릴 유일한
    // 정기 경로이기 때문이다(cron 없이 테이블이 자란다).
    await db.batch([
      db.prepare(SESSION_INSERT).bind(tokenHash, row.id, nowIso, expiresAt, ip, userAgent(input.request)),
      db.prepare(ATTEMPT_CLEAR).bind(ip, attemptKey),
      db.prepare(USER_TOUCH_LOGIN).bind(row.id, nowIso),
      db.prepare(SESSION_SWEEP).bind(nowIso),
      db.prepare(ATTEMPT_SWEEP).bind(windowStart),
    ]);
  } catch (e) {
    console.error("admin session create failed", e);
    return { ok: false, status: 503, error: "db_unavailable" };
  }

  return { ok: true, user: toUser(row), token, expiresAt };
}

// ─────────────────────────────────────────────────────────────
// 로그아웃
// ─────────────────────────────────────────────────────────────

/**
 * 멱등이다. 토큰이 없거나 이미 죽었어도 성공으로 답한다 — 실패로 답하면
 * 쿠키를 지우지 못한 채 로그아웃 버튼이 계속 실패하는 상태에 갇힌다.
 * 행을 지우지 않고 revoked=1 로 두는 것은 만료 스윕까지 흔적을 남기기 위해서다.
 */
export async function performAdminLogout(request: Request): Promise<void> {
  const db = bindings().DB;
  if (!db) return;
  const token = readSessionToken(request.headers.get("Cookie"));
  if (!token) return;
  try {
    await db.prepare(SESSION_REVOKE).bind(await hashSessionToken(token)).run();
  } catch (e) {
    console.error("admin logout failed", e);
  }
}

// ─────────────────────────────────────────────────────────────
// 최초 계정 부트스트랩
// ─────────────────────────────────────────────────────────────

export type BootstrapResult =
  | { ok: true; user: AdminUser }
  | { ok: false; status: 400 | 403 | 409 | 503; error: string; issues?: string[] };

/**
 * 계정이 **0개일 때 한 번만** 동작한다. 0006 에 계정 INSERT 를 넣지 않은 것은
 * preview 배포마다 마이그레이션이 재실행될 수 있어 시크릿이 박힌 계정이
 * 되살아나기 때문이다.
 *
 * ADMIN_BOOTSTRAP_SECRET 은 1회용이다. 계정을 만든 뒤 시크릿을 지우면 이
 * 경로는 `bootstrap_disabled` 로 완전히 닫힌다(계정이 이미 있으면 시크릿이
 * 남아 있어도 409 다).
 */
export async function bootstrapFirstAdmin(input: {
  providedSecret: unknown;
  username: unknown;
  password: unknown;
  role?: unknown;
  nowIso?: string;
}): Promise<BootstrapResult> {
  const db = bindings().DB;
  if (!db) return { ok: false, status: 503, error: "db_unavailable" };

  const env = bindings() as unknown as { ADMIN_BOOTSTRAP_SECRET?: string };
  const secret = String(env.ADMIN_BOOTSTRAP_SECRET ?? "");
  if (!secret) return { ok: false, status: 403, error: "bootstrap_disabled" };
  if (!constantTimeEqual(String(input.providedSecret ?? ""), secret))
    return { ok: false, status: 403, error: "invalid_secret" };

  const nowIso = input.nowIso ?? new Date().toISOString();
  const username = normalizeUsername(input.username);
  const password = String(input.password ?? "");
  const issues = [...usernameIssues(username), ...passwordIssues(password)];
  // 역할은 오타를 조용히 삼키지 않는다. parseRole 은 모르는 값을 viewer 로
  // 떨어뜨리는데, 여기서 그러면 첫 계정이 미션을 못 고치는 viewer 가 된 채
  // 409 때문에 다시 만들 수도 없다.
  if (input.role !== undefined && !(ADMIN_ROLES as readonly unknown[]).includes(input.role))
    issues.push("role.invalid");
  if (issues.length > 0) return { ok: false, status: 400, error: "invalid_input", issues };

  const role: AdminRole = input.role === undefined ? "admin" : parseRole(input.role);

  try {
    const count = await primary(db).prepare(USER_COUNT).first<{ c: number }>();
    if (Number(count?.c ?? 0) > 0) return { ok: false, status: 409, error: "already_bootstrapped" };

    const rec = await makePasswordRecord(password);
    const id = crypto.randomUUID();
    await db
      .prepare(USER_INSERT)
      .bind(id, username, rec.pwHash, rec.pwSalt, rec.pwIterations, role, nowIso)
      .run();
    return { ok: true, user: { id, username, role } };
  } catch (e) {
    console.error("admin bootstrap failed", e);
    return { ok: false, status: 503, error: "db_unavailable" };
  }
}

// ─────────────────────────────────────────────────────────────
// 응답 헬퍼
// ─────────────────────────────────────────────────────────────

/** 인증 응답은 전부 no-store 다. 중간 캐시에 세션 상태가 남으면 안 된다. */
export function noStoreJson(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
