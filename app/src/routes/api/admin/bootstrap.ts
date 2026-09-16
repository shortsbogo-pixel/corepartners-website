import { createFileRoute } from "@tanstack/react-router";
import { isSameOriginRequest } from "../../../lib/admin-auth";
import { bootstrapFirstAdmin, noStoreJson } from "../../../lib/admin-auth.server";
import { checkWriteAccess, writeForbiddenResponse } from "../../../lib/missions.server";

// 최초 관리자 계정 생성 (4-2C). **계정이 0개일 때 한 번만** 동작한다.
//
//   201 { ok:true, user:{id,username,role} }
//   400 { ok:false, error:'bad_json' | 'invalid_input', issues:[…] }
//   403 { ok:false, error:'bootstrap_disabled' | 'invalid_secret' | 'write_forbidden' | 'cross_origin' }
//   409 { ok:false, error:'already_bootstrapped' }
//   503 { ok:false, error:'db_unavailable' }
//
// 마이그레이션 0006 에 계정 INSERT 를 넣지 않은 이유가 이 경로의 존재 이유다:
// preview 배포마다 마이그레이션이 재실행될 수 있어, 시크릿이 박힌 계정이
// 지워도 지워도 되살아난다.
//
// ADMIN_BOOTSTRAP_SECRET 은 1회용이다. 계정을 만든 뒤 시크릿을 지우면 이
// 경로는 'bootstrap_disabled' 로 닫히고, 시크릿을 지우지 않아도 계정이 이미
// 있으므로 409 다. 즉 **두 겹으로 닫힌다.**
//
// 이 엔드포인트도 쓰기 게이트를 통과해야 한다. preview 와 production 이 D1 을
// 공유하므로, 게이트가 없으면 아무 preview 에서나 첫 계정을 선점할 수 있다.
export const Route = createFileRoute("/api/admin/bootstrap")({
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

        const result = await bootstrapFirstAdmin({
          providedSecret: body.secret,
          username: body.username,
          password: body.password,
          role: body.role,
        });

        if (!result.ok)
          return noStoreJson(
            { ok: false, error: result.error, issues: result.issues },
            result.status,
          );

        return noStoreJson({ ok: true, user: result.user }, 201);
      },
    },
  },
});
