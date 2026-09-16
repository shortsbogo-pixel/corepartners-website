import { createFileRoute } from "@tanstack/react-router";
import {
  SESSION_TTL_MIN,
  buildSessionCookie,
  isSameOriginRequest,
  shouldUseSecureCookie,
} from "../../../lib/admin-auth";
import { noStoreJson, performAdminLogin } from "../../../lib/admin-auth.server";
import { checkWriteAccess, writeForbiddenResponse } from "../../../lib/missions.server";

// 관리자 로그인 — 아이디·비밀번호를 세션 쿠키로 바꾼다 (4-2C).
//
// 응답
//   200 { ok:true, user:{id,username,role}, expiresAt } + Set-Cookie
//   400 { ok:false, error:'bad_json' | 'missing_credentials' }
//   401 { ok:false, error:'invalid_credentials' }
//        없는 아이디 · 잠긴 계정 · 틀린 비밀번호가 **전부 같은 응답**이다.
//   403 { ok:false, error:'write_forbidden' | 'cross_origin' }
//   429 { ok:false, error:'too_many_attempts', retryAfterSec } + Retry-After
//   503 { ok:false, error:'db_unavailable' }
//
// 쓰기 게이트를 로그인에도 건다. 세션 발급은 그 자체가 쓰기이고, preview 와
// production 이 D1 을 공유하므로 게이트를 걸지 않으면 preview 에서 만든 세션이
// production 에서도 유효해진다. 아무것도 설정하지 않은 배포는 **로그인 자체가
// 닫힌다**(fail-closed). 운영 호스트에만 ADMIN_WRITES_ENABLED 와
// ADMIN_ALLOWED_HOSTS 를 넣는다.
//
// ADMIN_KEY 와의 교환 경로는 **만들지 않았다.** 0006 은 세션 교환 경로에서만
// ADMIN_KEY 를 허용하지만, 그 경로를 만들면 URL 에 실리는 단일 시크릿이 계속
// 살아 있게 된다. 최초 계정은 /api/admin/bootstrap 이 만들고, 그 뒤로는
// 비밀번호 로그인만 쓴다.
export const Route = createFileRoute("/api/admin/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const access = checkWriteAccess(request);
        if (!access.allowed) return writeForbiddenResponse(access);

        const url = new URL(request.url);
        if (!isSameOriginRequest({ origin: request.headers.get("Origin"), host: url.host }))
          return noStoreJson({ ok: false, error: "cross_origin" }, 403);

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return noStoreJson({ ok: false, error: "bad_json" }, 400);
        }

        const result = await performAdminLogin({
          request,
          username: body.username,
          password: body.password,
        });

        if (!result.ok) {
          const headers: Record<string, string> = {};
          if (result.retryAfterSec) headers["Retry-After"] = String(result.retryAfterSec);
          return noStoreJson(
            { ok: false, error: result.error, retryAfterSec: result.retryAfterSec },
            result.status,
            headers,
          );
        }

        return noStoreJson({ ok: true, user: result.user, expiresAt: result.expiresAt }, 200, {
          "Set-Cookie": buildSessionCookie(result.token, {
            secure: shouldUseSecureCookie(request.url),
            maxAgeSec: SESSION_TTL_MIN * 60,
          }),
        });
      },
    },
  },
});
