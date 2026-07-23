import { createFileRoute } from "@tanstack/react-router";
import homeHtml from "../site/home.html?raw";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async () =>
        new Response(homeHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" },
        }),
    },
  },
});
