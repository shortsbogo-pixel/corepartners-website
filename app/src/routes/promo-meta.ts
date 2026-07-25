import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";

// Current promo metadata (label / period / updated / end) saved by the admin
// upload panel. 404 when none uploaded yet — the page falls back to baked-in
// defaults.
export const Route = createFileRoute("/promo-meta")({
  server: {
    handlers: {
      GET: async () => {
        const storage = bindings().STORAGE;
        if (storage) {
          try {
            const obj = await storage.get("promo-meta");
            if (obj) {
              return new Response(await obj.text(), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, must-revalidate" },
              });
            }
          } catch {
            // fall through
          }
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    },
  },
});
