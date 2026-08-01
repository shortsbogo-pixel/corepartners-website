import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";
import { buildPayload, listPublishedMissions } from "../lib/missions.server";

// 공개 미션 데이터. 미션보드가 이 응답을 소비한다(연결은 4-2D).
//
// 응답 계약 (missions.ts 의 classifyMissionResponse 와 짝을 이룬다)
//   200 { ok:true, schema, serverNow, missions:[…] }  정상. missions 가 빈 배열이면
//                                                    **정상 빈 상태**이며 정적 폴백이 아니다.
//   503 { ok:false, error }                          저장소 이용 불가 → 클라이언트 정적 폴백
//
// 4xx 를 따로 만들지 않는다. 라우트가 없는 예전 배포에서는 SPA 404 HTML 이
// 돌아오고, 그 본문은 계약을 만족하지 못해 스키마 폴백으로 떨어진다.
//
// 캐시는 기존 /promo-meta 와 같은 정책(no-cache, must-revalidate)을 쓴다.
// 미션은 시각에 따라 상태가 바뀌므로 중간 캐시가 붙으면 안 된다.
export const Route = createFileRoute("/mission-data")({
  server: {
    handlers: {
      GET: async () => {
        const headers = {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache, must-revalidate",
        };
        const db = bindings().DB;
        const nowIso = new Date().toISOString();

        if (!db) {
          return new Response(JSON.stringify({ ok: false, error: "db_unavailable" }), {
            status: 503,
            headers,
          });
        }

        try {
          const missions = await listPublishedMissions(db, nowIso);
          return new Response(JSON.stringify(buildPayload(missions, nowIso)), { status: 200, headers });
        } catch (e) {
          // 마이그레이션 전(테이블 없음)·쿼리 실패 모두 여기로 온다.
          // 정상 빈 상태와 구분하기 위해 200 빈 배열을 절대 돌려주지 않는다.
          console.error("mission-data query failed", e);
          return new Response(JSON.stringify({ ok: false, error: "query_failed" }), {
            status: 503,
            headers,
          });
        }
      },
    },
  },
});
