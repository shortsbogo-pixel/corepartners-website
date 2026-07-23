import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";

// Serves the current weekly promo banner: R2-uploaded version if present,
// otherwise falls back to the static asset shipped with the site.
export const Route = createFileRoute("/promo-banner")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const storage = bindings().STORAGE;
        if (storage) {
          try {
            const obj = await storage.get("promo-week");
            if (obj) {
              return new Response(obj.body as ReadableStream, {
                headers: {
                  "Content-Type": obj.httpMetadata?.contentType ?? "image/webp",
                  "Cache-Control": "no-cache, must-revalidate",
                },
              });
            }
          } catch {
            // fall through to static fallback
          }
        }
        return Response.redirect(new URL("/assets/promo-week.webp", request.url).toString(), 302);
      },
    },
  },
});
