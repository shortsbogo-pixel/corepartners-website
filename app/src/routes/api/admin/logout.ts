import { createFileRoute } from "@tanstack/react-router";
import {
  buildSessionClearCookie,
  isSameOriginRequest,
  shouldUseSecureCookie,
} from "../../../lib/admin-auth";
import { noStoreJson, performAdminLogout } from "../../../lib/admin-auth.server";

// 관리자 로그아웃 (4-2C).
//
// **멱등이며 언제나 200 이다.** 세션이 없거나 이미 죽었어도, D1 이 없어도
// 쿠키를 지우고 성공으로 답한다 — 실패로 답하면 쿠키가 남은 채 로그아웃이
// 계속 실패하는 상태에 갇힌다.
//
// 쓰기 게이트(checkWriteAccess)를 걸지 않는다. 로그인은 막아야 할 쓰기지만
// 로그아웃은 **권한을 줄이는 쪽**이라 어떤 배포에서도 항상 열려 있어야 한다.
export const Route = createFileRoute("/api/admin/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (!isSameOriginRequest({ origin: request.headers.get("Origin"), host: url.host }))
          return noStoreJson({ ok: false, error: "cross_origin" }, 403);

        await performAdminLogout(request);
        return noStoreJson({ ok: true }, 200, {
          "Set-Cookie": buildSessionClearCookie(shouldUseSecureCookie(request.url)),
        });
      },
    },
  },
});
