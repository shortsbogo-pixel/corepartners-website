import { createFileRoute } from "@tanstack/react-router";
import centerHtml from "../site/center.html?raw";
export const Route = createFileRoute("/center")({
  server: { handlers: { GET: async () => new Response(centerHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }) } },
});
