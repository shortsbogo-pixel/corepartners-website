import { createFileRoute } from "@tanstack/react-router";
import coupangHtml from "../site/coupang.html?raw";

export const Route = createFileRoute("/coupang-plus")({
  server: {
    handlers: {
      GET: async () =>
        new Response(coupangHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  },
});
