import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { buildPromoMeta, cleanField } from "../../lib/promo-meta";

const ALLOWED = new Set(["image/webp", "image/png", "image/jpeg"]);
const MAX_BYTES = 5 * 1024 * 1024;

export const Route = createFileRoute("/api/promo-upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") ?? "";
        const env = bindings() as unknown as { ADMIN_KEY?: string };
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
          return new Response("Unauthorized", { status: 401 });
        }
        const storage = bindings().STORAGE;
        if (!storage) return new Response("Storage not available", { status: 500 });

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("잘못된 요청입니다.", { status: 400 });
        }
        const file = form.get("banner");
        if (!(file instanceof File) || file.size === 0) {
          return new Response("이미지 파일을 선택해 주세요.", { status: 400 });
        }
        if (!ALLOWED.has(file.type)) {
          return new Response("webp / png / jpg 이미지만 업로드할 수 있습니다.", { status: 400 });
        }
        if (file.size > MAX_BYTES) {
          return new Response("파일이 너무 큽니다 (최대 5MB).", { status: 400 });
        }
        // Validate the week label / period BEFORE touching storage, so a bad
        // date never leaves a new image paired with old or broken metadata.
        const built = buildPromoMeta(
          {
            label: cleanField(form.get("label"), 60),
            start: cleanField(form.get("start"), 20),
            end: cleanField(form.get("end"), 20),
          },
          new Date(),
        );
        if (!built.ok) {
          return new Response(built.error, { status: 400 });
        }
        await storage.put("promo-week", await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type },
        });
        // Always rewrite promo-meta with the new banner: it carries the version
        // (`v`) that cache-busts the public image URL, and an upload without a
        // label/period must not keep showing last week's period.
        await storage.put("promo-meta", JSON.stringify(built.meta), {
          httpMetadata: { contentType: "application/json" },
        });
        // back to the admin page with a success flag
        return Response.redirect(
          new URL(`/admin?key=${encodeURIComponent(key)}&promo=ok`, request.url).toString(),
          303,
        );
      },
    },
  },
});
