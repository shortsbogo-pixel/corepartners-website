import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";
import { loadMissionData } from "../lib/missions.server";

// 공개 미션 데이터. 미션보드가 이 응답을 소비한다(연결은 4-2D).
//
// 응답 계약 (missions.ts 의 classifyMissionResponse 와 짝을 이룬다)
//   200 { ok:true, schema, source:'dynamic', serverNow, missions:[…] }
//        정상. missions 가 빈 배열이면 **정상 빈 상태**이며 정적 폴백이 아니다.
//        전체 미션 비활성·게시 기간 밖도 여기에 해당한다.
//   200 { ok:true, schema, source:'static',  serverNow, missions:[] }
//        운영자가 ops_settings.mission_source='static' 으로 꺼 둔 상태.
//        보드는 정적 상수로 렌더하되 **장애가 아니다.**
//   503 { ok:false, error }
//        D1 바인딩 부재 또는 쿼리 장애뿐. 클라이언트는 정적 폴백 + 오류 보고.
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
        const result = await loadMissionData(bindings().DB, new Date().toISOString());
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache, must-revalidate",
          },
        });
      },
    },
  },
});
