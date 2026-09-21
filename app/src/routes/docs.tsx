import { createFileRoute } from "@tanstack/react-router";
import docsHtml from "../site/docs.html?raw";

export const Route = createFileRoute("/docs")({
  server: {
    handlers: {
      GET: async () =>
        new Response(docsHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" },
        }),
    },
  },
});
