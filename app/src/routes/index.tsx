import { createFileRoute } from "@tanstack/react-router";
import homeHtml from "../site/home.html?raw";
import { applyMissionConfig } from "../lib/mission-config";
import { loadMissionConfig } from "../lib/mission-config.server";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async () => {
        const { config } = await loadMissionConfig();
        return new Response(applyMissionConfig(homeHtml, config), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, must-revalidate",
          },
        });
      },
    },
  },
});
