// 4-2C 단위 테스트 — 관리자 인증 도메인(순수 + WebCrypto).
// 실행: node --experimental-strip-types --test app/tests/admin-auth.test.ts
//   또는 bun test app/tests/admin-auth.test.ts
//
// D1 접근(admin-auth.server.ts)은 `cloudflare:workers` 를 import 하므로 여기서
// 부르지 않는다. 저장소가 필요한 부분(잠금 SQL·세션 CASCADE)은 schema_test.py
// 가 실제 SQLite 엔진으로 검증한다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOGIN_WINDOW_MS,
  MAX_COMBO_FAILURES,
  MAX_IP_FAILURES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PBKDF2_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  SESSION_COOKIE,
  SESSION_TTL_MIN,
  buildSessionClearCookie,
  buildSessionCookie,
  burnPasswordTime,
  bytesToBase64Url,
  bytesToHex,
  canWriteMissions,
  classifySession,
  clientIpFrom,
  constantTimeEqual,
  derivePasswordHash,
  evaluateLoginThrottle,
  generateSaltHex,
  generateSessionToken,
  hashSessionToken,
  hexToBytes,
  isSameOriginRequest,
  makePasswordRecord,
  normalizeUsername,
  parseCookies,
  parseRole,
  passwordIssues,
  readSessionToken,
  sessionExpiryIso,
  shouldRenewSession,
  shouldUseSecureCookie,
  throttleUsernameKey,
  usernameIssues,
  verifyPassword,
  windowStartFor,
} from "../src/lib/admin-auth.ts";

// PBKDF2 는 한 번에 100ms 안팎을 쓴다. 반복 수 자체를 검증하는 자리 말고는
// 최소치로 돌려 테스트 시간을 아낀다(알고리즘은 반복 수와 무관하게 같다).
const FAST = PBKDF2_MIN_ITERATIONS;

describe("바이트 · 인코딩", () => {
  it("hex 왕복", () => {
    const b = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
    assert.equal(bytesToHex(b), "00010f107f80ff");
    assert.deepEqual(Array.from(hexToBytes("00010f107f80ff")), Array.from(b));
  });

  it("hex 가 아닌 입력은 거부한다", () => {
    assert.throws(() => hexToBytes("abc"), RangeError); // 홀수 길이
    assert.throws(() => hexToBytes("zz"), RangeError);
  });

  it("base64url 은 패딩과 +/ 를 쓰지 않는다 — 쿠키에 그대로 실린다", () => {
    const b = new Uint8Array([251, 255, 190, 255]);
    const s = bytesToBase64Url(b);
    assert.ok(!/[+/=]/.test(s), s);
    assert.match(s, /^[A-Za-z0-9_-]+$/);
  });

  it("constantTimeEqual — 길이가 다르면 false, 같으면 내용 비교", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
    assert.equal(constantTimeEqual("", ""), true);
  });
});

describe("아이디 · 비밀번호 규칙", () => {
  it("아이디는 공백을 털고 소문자로 정규화한다", () => {
    assert.equal(normalizeUsername("  ChulSoo  "), "chulsoo");
    assert.equal(normalizeUsername(null), "");
  });

  it("계정 생성 시 아이디 규칙", () => {
    assert.deepEqual(usernameIssues("core.admin"), []);
    assert.deepEqual(usernameIssues("ab"), ["username.tooShort"]);
    assert.ok(usernameIssues("코어관리자").includes("username.charset"));
    assert.ok(usernameIssues("a".repeat(61)).includes("username.tooLong"));
  });

  it("비밀번호는 길이로 강제한다", () => {
    assert.deepEqual(passwordIssues("a".repeat(MIN_PASSWORD_LENGTH)), []);
    assert.deepEqual(passwordIssues("a".repeat(MIN_PASSWORD_LENGTH - 1)), ["password.tooShort"]);
    assert.ok(passwordIssues("a".repeat(MAX_PASSWORD_LENGTH + 1)).includes("password.tooLong"));
  });

  it("제어문자와 공백뿐인 비밀번호를 걸러낸다", () => {
    assert.ok(passwordIssues("abcdefgh\u0000ijkl").includes("password.control"));
    assert.ok(passwordIssues(" ".repeat(20)).includes("password.blank"));
  });
});

describe("PBKDF2 해싱", () => {
  it("같은 입력은 같은 해시, 소금이 다르면 다른 해시", async () => {
    const a = await derivePasswordHash("올바른말배터리스테이플", "0011223344556677", FAST);
    const b = await derivePasswordHash("올바른말배터리스테이플", "0011223344556677", FAST);
    const c = await derivePasswordHash("올바른말배터리스테이플", "7766554433221100", FAST);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 64); // 256비트 hex
  });

  it("반복 수가 다르면 해시도 다르다 — 저장된 값으로만 검증해야 한다", async () => {
    const a = await derivePasswordHash("passphrase-1234", "0011223344556677", FAST);
    const b = await derivePasswordHash("passphrase-1234", "0011223344556677", FAST + 1);
    assert.notEqual(a, b);
  });

  it("최소 반복 수 미만은 거부한다", async () => {
    await assert.rejects(
      () => derivePasswordHash("passphrase-1234", "0011223344556677", 1000),
      RangeError,
    );
  });

  it("NFKC 정규화 — 전각 입력도 같은 비밀번호로 본다", async () => {
    const ascii = await derivePasswordHash("abcdefghijkl", "0011223344556677", FAST);
    const full = await derivePasswordHash("ａｂｃｄｅｆｇｈｉｊｋｌ", "0011223344556677", FAST);
    assert.equal(ascii, full);
  });

  it("makePasswordRecord 는 계정마다 다른 소금을 쓴다", async () => {
    const [x, y] = await Promise.all([
      makePasswordRecord("correct-horse-battery"),
      makePasswordRecord("correct-horse-battery"),
    ]);
    assert.notEqual(x.pwSalt, y.pwSalt);
    assert.notEqual(x.pwHash, y.pwHash);
    assert.equal(x.pwIterations, PBKDF2_ITERATIONS);
  });

  it("verifyPassword — 맞으면 true, 틀리면 false", async () => {
    const salt = generateSaltHex();
    const rec = {
      pwSalt: salt,
      pwIterations: FAST,
      pwHash: await derivePasswordHash("correct-horse-battery", salt, FAST),
    };
    assert.equal(await verifyPassword("correct-horse-battery", rec), true);
    assert.equal(await verifyPassword("correct-horse-batterY", rec), false);
  });

  it("verifyPassword — 손상된 레코드는 던지지 않고 false 다", async () => {
    assert.equal(
      await verifyPassword("whatever-1234", { pwSalt: "zz", pwIterations: FAST, pwHash: "x" }),
      false,
    );
    assert.equal(
      await verifyPassword("whatever-1234", { pwSalt: "00112233", pwIterations: 1, pwHash: "x" }),
      false,
    );
  });

  it("burnPasswordTime 은 결과 없이 조용히 끝난다", async () => {
    assert.equal(await burnPasswordTime("anything"), undefined);
  });

  it("소금은 16바이트 hex 다", () => {
    assert.match(generateSaltHex(), /^[0-9a-f]{32}$/);
  });
});

describe("세션 토큰", () => {
  it("토큰은 쿠키에 안전한 문자만 쓰고 매번 다르다", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const t = generateSessionToken();
      assert.match(t, /^[A-Za-z0-9_-]+$/);
      assert.ok(t.length >= 40, t);
      seen.add(t);
    }
    assert.equal(seen.size, 50);
  });

  it("저장하는 값은 SHA-256 hex 64자 — 0006 의 CHECK 와 같은 길이", async () => {
    const t = generateSessionToken();
    const h = await hashSessionToken(t);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(await hashSessionToken(t), h);
    assert.notEqual(await hashSessionToken(generateSessionToken()), h);
  });

  it("해시에서 원문을 복원할 수 없다 — 값이 서로 다르다", async () => {
    const t = generateSessionToken();
    assert.notEqual(await hashSessionToken(t), t);
  });
});

describe("세션 만료", () => {
  const now = "2026-08-05T00:00:00.000Z";

  it("만료 시각은 TTL 만큼 뒤다", () => {
    assert.equal(sessionExpiryIso(now, 60), "2026-08-05T01:00:00.000Z");
    assert.equal(sessionExpiryIso(now), new Date(Date.parse(now) + SESSION_TTL_MIN * 60000).toISOString());
  });

  it("읽을 수 없는 시각은 던진다", () => {
    assert.throws(() => sessionExpiryIso("어제"), RangeError);
  });

  it("살아 있는 세션 · 만료된 세션 · 회수된 세션", () => {
    assert.equal(classifySession({ revoked: 0, expiresAt: "2026-08-05T01:00:00Z" }, now), "valid");
    assert.equal(classifySession({ revoked: 0, expiresAt: "2026-08-04T23:59:59Z" }, now), "expired");
    assert.equal(classifySession({ revoked: 1, expiresAt: "2026-08-05T01:00:00Z" }, now), "revoked");
    assert.equal(classifySession({ revoked: true, expiresAt: "2026-08-05T01:00:00Z" }, now), "revoked");
  });

  it("만료 시각을 못 읽으면 expired 다 (fail-closed)", () => {
    assert.equal(classifySession({ revoked: 0, expiresAt: null }, now), "expired");
    assert.equal(classifySession({ revoked: 0, expiresAt: "곧" }, now), "expired");
  });

  it("정확히 만료 시각이면 expired — 경계는 닫힌다", () => {
    assert.equal(classifySession({ revoked: 0, expiresAt: now }, now), "expired");
  });

  it("남은 시간이 TTL 의 1/4 미만일 때만 연장한다", () => {
    const ttl = 12 * 60;
    // 남은 2시간 = TTL 의 1/6 → 연장
    assert.equal(shouldRenewSession("2026-08-05T02:00:00.000Z", now, ttl), true);
    // 남은 4시간 = TTL 의 1/3 → 그대로
    assert.equal(shouldRenewSession("2026-08-05T04:00:00.000Z", now, ttl), false);
    // 이미 만료된 세션은 연장 대상이 아니다
    assert.equal(shouldRenewSession("2026-08-04T23:00:00.000Z", now, ttl), false);
    assert.equal(shouldRenewSession("언젠가", now, ttl), false);
  });
});

describe("쿠키", () => {
  it("세션 쿠키는 HttpOnly · SameSite=Strict · Path=/ 다", () => {
    const c = buildSessionCookie("tok123", { secure: true, maxAgeSec: 3600 });
    assert.ok(c.startsWith(`${SESSION_COOKIE}=tok123;`));
    assert.ok(c.includes("HttpOnly"));
    assert.ok(c.includes("SameSite=Strict"));
    assert.ok(c.includes("Path=/"));
    assert.ok(c.includes("Max-Age=3600"));
    assert.ok(c.includes("Secure"));
  });

  it("http 로컬 개발에서만 Secure 가 빠진다", () => {
    assert.ok(!buildSessionCookie("t", { secure: false, maxAgeSec: 1 }).includes("Secure"));
  });

  it("삭제 쿠키는 Max-Age=0 이고 값이 비어 있다", () => {
    const c = buildSessionClearCookie(true);
    assert.ok(c.startsWith(`${SESSION_COOKIE}=;`));
    assert.ok(c.includes("Max-Age=0"));
  });

  it("같은 이름의 쿠키를 모두 보존한다", () => {
    const m = parseCookies("a=1; b=2; a=3");
    assert.deepEqual(m.get("a"), ["1", "3"]);
    assert.deepEqual(m.get("b"), ["2"]);
  });

  it("값에 = 가 들어 있어도 첫 = 에서만 자른다", () => {
    assert.deepEqual(parseCookies("t=aa=bb").get("t"), ["aa=bb"]);
  });

  it("세션 토큰을 읽는다", () => {
    const tok = generateSessionToken();
    assert.equal(readSessionToken(`x=1; ${SESSION_COOKIE}=${tok}`), tok);
    assert.equal(readSessionToken("x=1"), null);
    assert.equal(readSessionToken(null), null);
  });

  it("쿠키 셰도잉 — 같은 이름이 둘이면 세션이 없는 것으로 본다", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    assert.equal(readSessionToken(`${SESSION_COOKIE}=${a}; ${SESSION_COOKIE}=${b}`), null);
  });

  it("토큰 모양이 아니면 조회조차 하지 않는다", () => {
    assert.equal(readSessionToken(`${SESSION_COOKIE}=short`), null);
    assert.equal(readSessionToken(`${SESSION_COOKIE}=${"a".repeat(200)}`), null);
    assert.equal(readSessionToken(`${SESSION_COOKIE}=abc!def!ghi!jkl!mno!`), null);
  });
});

describe("로그인 잠금", () => {
  const base = Date.UTC(2026, 7, 5, 0, 0, 0);

  it("창은 고정 길이로 끊는다", () => {
    assert.equal(windowStartFor(base), base);
    assert.equal(windowStartFor(base + LOGIN_WINDOW_MS - 1), base);
    assert.equal(windowStartFor(base + LOGIN_WINDOW_MS), base + LOGIN_WINDOW_MS);
  });

  it("실패가 적으면 통과한다", () => {
    const r = evaluateLoginThrottle({ comboFailures: 1, ipFailures: 3, nowMs: base });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "ok");
  });

  it("같은 IP·아이디 조합이 한도에 닿으면 잠근다", () => {
    const r = evaluateLoginThrottle({
      comboFailures: MAX_COMBO_FAILURES,
      ipFailures: MAX_COMBO_FAILURES,
      nowMs: base,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "combo_locked");
  });

  it("아이디를 바꿔 가며 훑어도 IP 합산에서 걸린다", () => {
    const r = evaluateLoginThrottle({ comboFailures: 1, ipFailures: MAX_IP_FAILURES, nowMs: base });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "ip_locked");
  });

  it("Retry-After 는 창이 끝날 때까지의 시간이다", () => {
    const r = evaluateLoginThrottle({
      comboFailures: MAX_COMBO_FAILURES,
      ipFailures: 0,
      nowMs: base + LOGIN_WINDOW_MS - 30_000,
    });
    assert.equal(r.retryAfterSec, 30);
    const atEdge = evaluateLoginThrottle({
      comboFailures: MAX_COMBO_FAILURES,
      ipFailures: 0,
      nowMs: base + LOGIN_WINDOW_MS - 1,
    });
    assert.equal(atEdge.retryAfterSec, 1); // 0 을 돌려주면 즉시 재시도가 된다
  });

  it("집계 키는 60자로 자른다 — 긴 아이디로 집계를 피할 수 없다", () => {
    assert.equal(throttleUsernameKey("a".repeat(100)).length, 60);
    assert.equal(throttleUsernameKey("  ADMIN  "), "admin");
    // 길이 0 은 0006 의 CHECK 에 걸려 기록 자체가 사라진다
    assert.equal(throttleUsernameKey(""), "-");
  });

  it("통과했을 때는 재시도 대기가 없다", () => {
    assert.equal(evaluateLoginThrottle({ comboFailures: 0, ipFailures: 0, nowMs: base }).retryAfterSec, 0);
  });
});

describe("요청 판정", () => {
  it("Origin 이 없으면 통과 — 브라우저가 아닌 클라이언트", () => {
    assert.equal(isSameOriginRequest({ origin: null, host: "xn--hq1b34l1zc.com" }), true);
    assert.equal(isSameOriginRequest({ origin: "", host: "example.com" }), true);
  });

  it("Origin 이 같은 호스트면 통과, 다르면 거부", () => {
    assert.equal(isSameOriginRequest({ origin: "https://a.com", host: "a.com" }), true);
    assert.equal(isSameOriginRequest({ origin: "https://evil.com", host: "a.com" }), false);
  });

  it("포트가 다르면 다른 오리진이다", () => {
    assert.equal(isSameOriginRequest({ origin: "http://a.com:8080", host: "a.com" }), false);
    assert.equal(isSameOriginRequest({ origin: "http://a.com:8080", host: "a.com:8080" }), true);
  });

  it("Origin 이 URL 이 아니면 거부한다", () => {
    assert.equal(isSameOriginRequest({ origin: "null", host: "a.com" }), false);
  });

  it("https 와 로컬 http 를 가른다", () => {
    assert.equal(shouldUseSecureCookie("https://a.com/x"), true);
    assert.equal(shouldUseSecureCookie("http://localhost:3000/x"), false);
    assert.equal(shouldUseSecureCookie("http://127.0.0.1:3000/x"), false);
    // 로컬이 아닌 http 에서 Secure 를 빼면 평문으로 쿠키가 흐른다
    assert.equal(shouldUseSecureCookie("http://a.com/x"), true);
    assert.equal(shouldUseSecureCookie("주소가아님"), true);
  });

  it("IP 는 CF-Connecting-IP 를 먼저 본다", () => {
    assert.equal(clientIpFrom({ cfConnectingIp: "1.2.3.4", forwardedFor: "9.9.9.9" }), "1.2.3.4");
    assert.equal(clientIpFrom({ forwardedFor: "9.9.9.9, 8.8.8.8" }), "9.9.9.9");
    assert.equal(clientIpFrom({}), "unknown");
  });

  it("IP 는 60자로 자른다 — 0006 의 CHECK 길이", () => {
    assert.equal(clientIpFrom({ cfConnectingIp: "a".repeat(80) }).length, 60);
  });
});

describe("역할", () => {
  it("모르는 값은 가장 약한 역할로 떨어진다", () => {
    assert.equal(parseRole("admin"), "admin");
    assert.equal(parseRole("EDITOR"), "editor");
    assert.equal(parseRole("superuser"), "viewer");
    assert.equal(parseRole(undefined), "viewer");
  });

  it("viewer 는 미션을 바꿀 수 없다", () => {
    assert.equal(canWriteMissions("admin"), true);
    assert.equal(canWriteMissions("editor"), true);
    assert.equal(canWriteMissions("viewer"), false);
  });
});
