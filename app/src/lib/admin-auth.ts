// 관리자 세션 인증 — 도메인 계층. 저장소 접근 0, `cloudflare:workers` import 0.
//
// missions.ts 와 같은 이유로 서버 모듈(admin-auth.server.ts)과 분리했다.
// 여기 있는 규칙(해싱·토큰·쿠키·잠금 창·만료 판정)은 Workers 런타임 밖에서
// 단위 테스트할 수 있어야 한다. WebCrypto(`crypto.subtle`)는 Workers 와
// node/bun 양쪽에 전역으로 있으므로 의존성이 아니다.
//
// 배경(마이그레이션 0006): 현행 /admin 은 `?key=<ADMIN_KEY>` 단일 시크릿을 쓴다.
// URL 에 실려 히스토리·Referer·로그에 남고, 만료·개별 회수가 안 되며, 무엇보다
// **누가 바꿨는지 식별할 수 없어 감사 로그의 actor 를 채울 수 없다.**

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

export const SESSION_COOKIE = "cp_admin_session";

/** 세션 절대 만료(분). 슬라이딩 갱신은 shouldRenewSession 이 정한다. */
export const SESSION_TTL_MIN = 12 * 60;

/**
 * 갱신 임계. 남은 시간이 TTL 의 이 비율보다 적을 때만 만료를 늘린다.
 * 요청마다 UPDATE 를 치면 읽기 전용 화면에서도 쓰기가 발생하므로 임계를 둔다.
 */
export const SESSION_RENEW_THRESHOLD = 0.25;

/**
 * PBKDF2 반복 수. 0006 의 `pw_iterations DEFAULT 210000`, `CHECK >= 100000`
 * 과 같은 값이다. SHA-256 210k 는 요청당 100~200ms 의 CPU 를 쓰므로 로그인은
 * Workers 의 CPU 한도가 넉넉한 요금제를 전제로 한다. 계정별로 저장하는 값이라
 * 나중에 올려도 기존 계정은 각자 저장된 값으로 계속 검증된다.
 */
export const PBKDF2_ITERATIONS = 210000;
export const PBKDF2_MIN_ITERATIONS = 100000;

export const SALT_BYTES = 16;
export const TOKEN_BYTES = 32;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 60;

/** 로그인 실패 집계 창(고정 창). admin_login_attempts.window_start 의 단위. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** (ip, username) 조합 — 특정 계정 표적 대입. */
export const MAX_COMBO_FAILURES = 5;
/** ip 단위 합산 — 아이디를 바꿔 가며 훑는 계정 열거. */
export const MAX_IP_FAILURES = 20;

export const ADMIN_ROLES = ["admin", "editor", "viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminUser {
  id: string;
  username: string;
  role: AdminRole;
}

// ─────────────────────────────────────────────────────────────
// 바이트 · 인코딩
// ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean))
    throw new RangeError("16진 문자열이 아닙니다.");
  // ArrayBuffer 를 명시해 Uint8Array<ArrayBufferLike> 가 되지 않게 한다 —
  // crypto.subtle 의 BufferSource 는 SharedArrayBuffer 를 받지 않는다.
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 쿠키에 그대로 실을 수 있도록 base64url(패딩 없음)로 쓴다. */
export function bytesToBase64Url(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 길이가 같을 때 내용 비교 시간이 값에 의존하지 않게 한다.
 * 길이 자체는 새지만, 여기서 비교하는 값(해시·고정 길이 시크릿)의 길이는
 * 비밀이 아니다.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────
// 비밀번호
// ─────────────────────────────────────────────────────────────

export function normalizeUsername(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** 계정 생성 시의 아이디 규칙. 로그인 경로는 정규화만 하고 이 검사를 쓰지 않는다. */
export function usernameIssues(v: unknown): string[] {
  const u = normalizeUsername(v);
  const out: string[] = [];
  if (u.length < MIN_USERNAME_LENGTH) out.push("username.tooShort");
  if (u.length > MAX_USERNAME_LENGTH) out.push("username.tooLong");
  if (u.length > 0 && !/^[a-z0-9._-]+$/.test(u)) out.push("username.charset");
  return out;
}

/**
 * 비밀번호 규칙. 문자 종류를 강제하는 대신 길이를 길게 잡는다 —
 * 종류 강제는 'Passw0rd!' 같은 예측 가능한 변형을 부를 뿐이다.
 */
export function passwordIssues(v: unknown): string[] {
  const pw = String(v ?? "");
  const out: string[] = [];
  if (pw.length < MIN_PASSWORD_LENGTH) out.push("password.tooShort");
  if (pw.length > MAX_PASSWORD_LENGTH) out.push("password.tooLong");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(pw)) out.push("password.control");
  if (pw.length > 0 && pw.trim().length === 0) out.push("password.blank");
  return out;
}

export function generateSaltHex(): string {
  const b = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/**
 * PBKDF2-SHA256. 입력을 NFKC 로 정규화해 입력기(IME·모바일 자판)에 따라
 * 같은 비밀번호가 다른 바이트열이 되는 일을 막는다.
 */
export async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS)
    throw new RangeError(`PBKDF2 반복 수가 최소치(${PBKDF2_MIN_ITERATIONS}) 미만입니다.`);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export interface PasswordRecord {
  pwHash: string;
  pwSalt: string;
  pwIterations: number;
}

export async function makePasswordRecord(password: string): Promise<PasswordRecord> {
  const pwSalt = generateSaltHex();
  return {
    pwSalt,
    pwIterations: PBKDF2_ITERATIONS,
    pwHash: await derivePasswordHash(password, pwSalt, PBKDF2_ITERATIONS),
  };
}

export async function verifyPassword(password: string, rec: PasswordRecord): Promise<boolean> {
  try {
    const got = await derivePasswordHash(password, rec.pwSalt, rec.pwIterations);
    return constantTimeEqual(got, rec.pwHash);
  } catch {
    return false;
  }
}

/**
 * 아이디가 없을 때도 같은 시간을 쓰기 위한 더미 검증.
 * 없는 아이디만 즉시 401 이 되면 응답 시간만으로 계정 존재를 알아낼 수 있다.
 */
export async function burnPasswordTime(password: string): Promise<void> {
  const salt = "00000000000000000000000000000000";
  try {
    await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
  } catch {
    /* 타이밍을 맞추는 것이 목적이므로 결과는 버린다 */
  }
}

// ─────────────────────────────────────────────────────────────
// 세션 토큰
// ─────────────────────────────────────────────────────────────

/** 원문 토큰. 쿠키로만 나가고 **DB 에는 절대 저장하지 않는다.** */
export function generateSessionToken(): string {
  const b = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(b);
  return bytesToBase64Url(b);
}

/**
 * DB 에 저장하는 값. SHA-256 hex 64자 — 0006 의
 * `CHECK (length(token_hash) = 64)` 와 같은 길이다.
 * 원문을 저장하지 않으므로 DB 가 통째로 새도 세션을 재사용할 수 없다.
 *
 * 비밀번호와 달리 늘림(stretching)을 하지 않는 이유: 토큰은 256비트 난수라
 * 사전 대입 대상이 아니고, 요청마다 검증하므로 비싸면 안 된다.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return bytesToHex(new Uint8Array(d));
}

export function sessionExpiryIso(nowIso: string, ttlMin: number = SESSION_TTL_MIN): string {
  const base = Date.parse(nowIso);
  if (Number.isNaN(base)) throw new RangeError(`시각 형식이 올바르지 않습니다: ${nowIso}`);
  return new Date(base + ttlMin * 60_000).toISOString();
}

export type SessionState = "valid" | "revoked" | "expired";

/** 만료 시각을 못 읽으면 **expired** 다(fail-closed). */
export function classifySession(
  s: { revoked: number | boolean; expiresAt: string | null | undefined },
  nowIso: string,
): SessionState {
  if (s.revoked === 1 || s.revoked === true) return "revoked";
  const exp = Date.parse(String(s.expiresAt ?? ""));
  const now = Date.parse(nowIso);
  if (Number.isNaN(exp) || Number.isNaN(now)) return "expired";
  return exp > now ? "valid" : "expired";
}

/** 남은 시간이 TTL 의 SESSION_RENEW_THRESHOLD 미만일 때만 갱신한다. */
export function shouldRenewSession(
  expiresAt: string,
  nowIso: string,
  ttlMin: number = SESSION_TTL_MIN,
): boolean {
  const exp = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(exp) || Number.isNaN(now)) return false;
  if (exp <= now) return false;
  return exp - now < ttlMin * 60_000 * SESSION_RENEW_THRESHOLD;
}

// ─────────────────────────────────────────────────────────────
// 쿠키
// ─────────────────────────────────────────────────────────────

export interface CookieOptions {
  /** http 로 도는 로컬 개발에서만 false. 그 밖에는 언제나 true. */
  secure: boolean;
  maxAgeSec: number;
}

/**
 * SameSite=Strict — 관리자 화면은 외부 사이트에서 넘어오는 요청이 없다.
 * 바깥 링크로 /admin 에 처음 들어오면 쿠키가 실리지 않아 로그아웃처럼 보이지만,
 * 그 대신 CSRF 를 브라우저 단계에서 끊는다. Path=/ 는 쿠키가 /api/admin/* 과
 * 화면 경로 양쪽에 실려야 하기 때문이다.
 */
export function buildSessionCookie(token: string, opt: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(opt.maxAgeSec))}`,
  ];
  if (opt.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildSessionClearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** 같은 이름이 여러 번 오면 **첫 값이 아니라 개수를 센다** — readSessionToken 참고. */
export function parseCookies(header: string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(v);
    out.set(k, list);
  }
  return out;
}

/**
 * 쿠키 셰도잉 방어. 상위 도메인이나 다른 경로에서 같은 이름의 쿠키를 심으면
 * 브라우저는 둘 다 보내고 순서는 보장되지 않는다. 어느 쪽을 고르든 공격자가
 * 고른 값을 쓸 위험이 있으므로 **중복이면 세션이 없는 것으로 취급한다.**
 */
export function readSessionToken(cookieHeader: string | null | undefined): string | null {
  const values = parseCookies(cookieHeader).get(SESSION_COOKIE);
  if (!values || values.length !== 1) return null;
  const token = values[0];
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return token;
}

// ─────────────────────────────────────────────────────────────
// 로그인 잠금
// ─────────────────────────────────────────────────────────────

/**
 * 잠금 집계에 쓸 아이디 키. 0006 의
 * `CHECK (username = lower(username) AND length(username) <= 60)` 에 맞춘다.
 * 자르지 않으면 60자를 넘는 아이디로 시도할 때마다 INSERT 가 CHECK 에 걸려
 * **실패가 집계되지 않고**, 그 길이로는 무한히 시도할 수 있게 된다.
 * 빈 아이디는 '-' 한 칸으로 모은다(길이 0 도 CHECK 에 걸린다).
 */
export function throttleUsernameKey(username: string): string {
  return normalizeUsername(username).slice(0, MAX_USERNAME_LENGTH) || "-";
}

export function windowStartFor(nowMs: number): number {
  return Math.floor(nowMs / LOGIN_WINDOW_MS) * LOGIN_WINDOW_MS;
}

export type ThrottleReason = "ok" | "combo_locked" | "ip_locked";

export interface ThrottleResult {
  allowed: boolean;
  reason: ThrottleReason;
  retryAfterSec: number;
}

/**
 * 두 층을 한 테이블로 강제한다(0006 의 설계).
 *   1) (ip, username) 조합 — 한 계정을 표적으로 하는 대입
 *   2) ip 단위 합산        — 아이디를 바꿔 가며 훑는 계정 열거
 *
 * IP 만으로 잡으면 사무실·모바일망에서 한 사람의 오타가 나머지를 잠그고,
 * 아이디만으로 잡으면 분산 IP 공격을 놓친다.
 */
export function evaluateLoginThrottle(input: {
  comboFailures: number;
  ipFailures: number;
  nowMs: number;
}): ThrottleResult {
  const remainMs = windowStartFor(input.nowMs) + LOGIN_WINDOW_MS - input.nowMs;
  const retryAfterSec = Math.max(1, Math.ceil(remainMs / 1000));
  if (input.comboFailures >= MAX_COMBO_FAILURES)
    return { allowed: false, reason: "combo_locked", retryAfterSec };
  if (input.ipFailures >= MAX_IP_FAILURES)
    return { allowed: false, reason: "ip_locked", retryAfterSec };
  return { allowed: true, reason: "ok", retryAfterSec: 0 };
}

// ─────────────────────────────────────────────────────────────
// 요청 판정
// ─────────────────────────────────────────────────────────────

/**
 * CSRF 2차 방어. SameSite=Strict 가 1차이고, 그것을 무시하는 브라우저를 위해
 * Origin 을 본다. Origin 이 **없으면 통과시킨다** — 브라우저가 아닌 클라이언트
 * (배포 스크립트·curl)는 Origin 을 붙이지 않으며, 그들은 애초에 쿠키를 자동으로
 * 싣지도 않아 CSRF 의 대상이 아니다.
 */
export function isSameOriginRequest(input: {
  origin?: string | null;
  host?: string | null;
}): boolean {
  const origin = String(input.origin ?? "").trim();
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return originHost === String(input.host ?? "").toLowerCase();
}

/** 로컬 http 개발을 빼면 언제나 Secure 쿠키를 쓴다. */
export function shouldUseSecureCookie(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  } catch {
    return true;
  }
}

/**
 * 클라이언트 IP. Cloudflare 가 붙이는 CF-Connecting-IP 를 먼저 보고,
 * 없으면 X-Forwarded-For 의 첫 항목을 쓴다. 두 값 모두 프록시가 덮어쓰는
 * 값이라 신뢰 경계 밖에서는 위조될 수 있다 — 잠금 키로만 쓰고 권한 판정에는
 * 쓰지 않는다. 0006 의 `CHECK (length(trim(ip)) BETWEEN 1 AND 60)` 에 맞춰
 * 자른다.
 */
export function clientIpFrom(headers: {
  cfConnectingIp?: string | null;
  forwardedFor?: string | null;
}): string {
  const cf = String(headers.cfConnectingIp ?? "").trim();
  if (cf) return cf.slice(0, 60);
  const xff = String(headers.forwardedFor ?? "").split(",")[0]?.trim() ?? "";
  if (xff) return xff.slice(0, 60);
  return "unknown";
}

export function parseRole(v: unknown): AdminRole {
  const s = String(v ?? "").trim().toLowerCase();
  return (ADMIN_ROLES as readonly string[]).includes(s) ? (s as AdminRole) : "viewer";
}

/** 미션을 바꿀 수 있는 역할. viewer 는 미리보기만 한다. */
export function canWriteMissions(role: AdminRole): boolean {
  return role === "admin" || role === "editor";
}
