import { createFileRoute } from "@tanstack/react-router";
import rentHtml from "../site/rent.html?raw";

export const Route = createFileRoute("/rent")({
  server: {
    handlers: {
      GET: async () =>
        new Response(rentHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" },
        }),
    },
  },
});
