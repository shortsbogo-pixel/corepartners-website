import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { validateMissionConfig } from "../../lib/mission-config";
import { saveMissionConfig } from "../../lib/mission-config.server";
import { buildPromoMeta, cleanField } from "../../lib/promo-meta";

const ALLOWED = new Set(["image/webp", "image/png", "image/jpeg"]);
const MAX_BYTES = 5 * 1024 * 1024;

// 관리자 "이번 주 미션 업데이트" 저장.
// - 배너 이미지(선택): 올리면 교체 + promo-meta 새로 저장(새 버전 v)
// - 미션 조건(missions_json, 선택): 검증 통과 + 확인 체크 시 mission-config 저장(이력 포함)
// - 둘 다 없으면 400. 모든 검증을 저장 전에 끝내서 반쯤 저장된 상태가 생기지 않게 한다.
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
        const bad = (msg: string) =>
          new Response(msg, {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });

        // ── 1) 배너 이미지(선택)
        const fileRaw = form.get("banner");
        const file = fileRaw instanceof File && fileRaw.size > 0 ? fileRaw : null;
        if (file) {
          if (!ALLOWED.has(file.type))
            return bad("webp / png / jpg 이미지만 업로드할 수 있습니다.");
          if (file.size > MAX_BYTES) return bad("파일이 너무 큽니다 (최대 5MB).");
        }

        // ── 2) 주차 라벨·기간
        const now = new Date();
        const label = cleanField(form.get("label"), 60);
        const start = cleanField(form.get("start"), 20);
        const end = cleanField(form.get("end"), 20);
        const built = buildPromoMeta({ label, start, end }, now);
        if (!built.ok) return bad(built.error);

        // ── 3) 미션 조건(선택)
        const missionsRaw = String(form.get("missions_json") ?? "").trim();
        let missions = null;
        if (missionsRaw) {
          if (String(form.get("confirm") ?? "") !== "1") {
            return bad(
              "미션 조건을 저장하려면 '배너와 조건을 대조해 확인했습니다'에 체크해 주세요.",
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(missionsRaw);
          } catch {
            return bad("미션 조건 형식이 올바르지 않습니다.");
          }
          const v = validateMissionConfig(parsed);
          if (!v.ok) return bad("미션 조건을 확인해 주세요:\n- " + v.errors.join("\n- "));
          missions = v.config;
        }

        if (!file && !missions)
          return bad("배너 이미지 또는 미션 조건 중 하나는 있어야 저장됩니다.");

        // ── 4) 저장 (검증을 모두 통과한 뒤)
        if (file) {
          await storage.put("promo-week", await file.arrayBuffer(), {
            httpMetadata: { contentType: file.type },
          });
          // 새 배너 → 새 버전(v). 기간 없이 올리면 지난 주 기간을 이어받지 않는다.
          await storage.put("promo-meta", JSON.stringify(built.meta), {
            httpMetadata: { contentType: "application/json" },
          });
        } else if (label || start || end) {
          // 배너는 그대로 두고 라벨·기간만 고치는 경우: 이미지 버전(v)은 유지
          let prevV = "";
          try {
            const prev = await storage.get("promo-meta");
            if (prev) prevV = String(((await prev.json()) as { v?: unknown }).v ?? "");
          } catch {
            /* 없으면 버전 없이 저장 */
          }
          await storage.put("promo-meta", JSON.stringify({ ...built.meta, v: prevV }), {
            httpMetadata: { contentType: "application/json" },
          });
        }
        if (missions) await saveMissionConfig(missions, now);

        // back to the admin page with a success flag
        return Response.redirect(
          new URL(`/admin?key=${encodeURIComponent(key)}&promo=ok`, request.url).toString(),
          303,
        );
      },
    },
  },
});
