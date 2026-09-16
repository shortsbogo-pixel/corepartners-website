import { createFileRoute } from "@tanstack/react-router";
import {
  SESSION_TTL_MIN,
  buildSessionClearCookie,
  buildSessionCookie,
  canWriteMissions,
  shouldUseSecureCookie,
} from "../../../lib/admin-auth";
import { authenticateAdmin, noStoreJson } from "../../../lib/admin-auth.server";

// 현재 세션 확인 (4-2C). 관리자 화면이 부팅할 때 이 응답으로 로그인 폼을
// 보여줄지 결정한다.
//
//   200 { ok:true, user:{id,username,role}, canWrite, expiresAt }
//   401 { ok:false, error:'no_session' | 'session_expired' | 'session_revoked' | 'user_disabled' }
//   503 { ok:false, error:'db_unavailable' }
//
// 읽기 전용이므로 쓰기 게이트를 걸지 않는다. 다만 세션이 **죽어 있을 때는**
// 쿠키를 지워 보낸다 — 살려 둬 봐야 매 요청 D1 조회만 한 번씩 더 태운다.
// 'no_session'(쿠키 자체가 없음)에는 지울 것이 없고, 'db_unavailable' 은
// 세션이 죽었다는 근거가 아니므로(장애일 뿐이다) 둘 다 쿠키를 건드리지 않는다.
export const Route = createFileRoute("/api/admin/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secure = shouldUseSecureCookie(request.url);
        const result = await authenticateAdmin(request);

        if (!result.ok) {
          const headers: Record<string, string> = {};
          if (result.error !== "no_session" && result.error !== "db_unavailable")
            headers["Set-Cookie"] = buildSessionClearCookie(secure);
          return noStoreJson({ ok: false, error: result.error }, result.status, headers);
        }

        // 세션을 연장했으면 쿠키의 Max-Age 도 같이 밀어 준다. 그러지 않으면
        // DB 는 살아 있는데 브라우저가 먼저 쿠키를 버린다.
        const headers: Record<string, string> = {};
        if (result.renewedTo)
          headers["Set-Cookie"] = buildSessionCookie(result.token, {
            secure,
            maxAgeSec: SESSION_TTL_MIN * 60,
          });

        return noStoreJson(
          {
            ok: true,
            user: result.user,
            canWrite: canWriteMissions(result.user.role),
            expiresAt: result.expiresAt,
          },
          200,
          headers,
        );
      },
    },
  },
});
