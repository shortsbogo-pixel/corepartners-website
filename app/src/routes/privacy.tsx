import { createFileRoute } from "@tanstack/react-router";
import privacyHtml from "../site/privacy.html?raw";
export const Route = createFileRoute("/privacy")({
  server: { handlers: { GET: async () => new Response(privacyHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" } }) } },
});
