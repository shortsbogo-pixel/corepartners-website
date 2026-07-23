import { createFileRoute } from "@tanstack/react-router";
import aboutHtml from "../site/about.html?raw";
export const Route = createFileRoute("/about")({
  server: { handlers: { GET: async () => new Response(aboutHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }) } },
});
