import { createFileRoute } from "@tanstack/react-router";
import storeHtml from "../site/store.html?raw";

export const Route = createFileRoute("/store")({
  server: {
    handlers: {
      GET: async () =>
        new Response(storeHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" },
        }),
    },
  },
});
