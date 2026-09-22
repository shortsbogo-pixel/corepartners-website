import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";
import { isBannerVersion } from "../lib/promo-meta";

// Serves the current weekly promo banner: R2-uploaded version if present,
// otherwise falls back to the static asset shipped with the site.
//
// Caching:
// - `/promo-banner` (no version) stays `no-cache` so a browser always
//   revalidates; the ETag lets that revalidation be a cheap 304 instead of
//   re-sending the whole image.
// - `/promo-banner?v=<upload ms>` is what the public page requests once it has
//   read `promo-meta.v`. Every admin upload writes a new `v`, so the URL itself
//   changes with the banner and a cached copy can never be a stale week.
export const Route = createFileRoute("/promo-banner")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const storage = bindings().STORAGE;
        const versioned = isBannerVersion(new URL(request.url).searchParams.get("v"));
        const cacheControl = versioned ? "public, max-age=86400" : "no-cache, must-revalidate";
        if (storage) {
          try {
            // Browser revalidation: If-None-Match → R2 conditional get.
            const inm = (request.headers.get("If-None-Match") ?? "")
              .replace(/^W\//, "")
              .replace(/"/g, "")
              .trim();
            const obj = inm
              ? await storage.get("promo-week", { onlyIf: { etagDoesNotMatch: inm } })
              : await storage.get("promo-week");
            if (obj) {
              const headers = new Headers({
                "Content-Type": obj.httpMetadata?.contentType ?? "image/webp",
                "Cache-Control": cacheControl,
                ETag: obj.httpEtag,
              });
              // onlyIf failed (If-None-Match matched) → R2 returns the object
              // without a body.
              if (!("body" in obj) || !obj.body) {
                return new Response(null, { status: 304, headers });
              }
              return new Response(obj.body as unknown as ReadableStream, { headers });
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
