import { createFileRoute } from "@tanstack/react-router";
import coupangHtml from "../site/coupang.html?raw";
import { applyMissionConfig } from "../lib/mission-config";
import { loadMissionConfig } from "../lib/mission-config.server";

// 미션 조건은 관리자(/admin)가 저장한 값(R2 mission-config)으로 서버에서 채운다.
// 저장값이 없으면 기본값(DEFAULT_MISSION_CONFIG)으로 렌더링한다.
export const Route = createFileRoute("/coupang-plus")({
  server: {
    handlers: {
      GET: async () => {
        const { config } = await loadMissionConfig();
        return new Response(applyMissionConfig(coupangHtml, config), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, must-revalidate",
          },
        });
      },
    },
  },
});
