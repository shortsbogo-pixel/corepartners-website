import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import {
  EXTRACT_FALLBACK_MODEL,
  EXTRACT_MODEL,
  EXTRACT_PROMPT,
  parseExtractResponse,
} from "../../lib/mission-extract";

// 관리자 전용: 배너 이미지를 AI로 읽어 미션 조건 "초안"을 돌려준다. 저장은 하지 않는다.
// 관리자 화면이 이미지를 1600px 이하 JPEG 로 줄여서 보낸다.
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 3.5 * 1024 * 1024; // base64 로 5MB(API 한도) 이하가 되도록

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export const Route = createFileRoute("/api/promo-extract")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") ?? "";
        const env = bindings() as unknown as { ADMIN_KEY?: string; ANTHROPIC_API_KEY?: string };
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }
        if (!env.ANTHROPIC_API_KEY) {
          return Response.json({
            ok: false,
            error: "AI 키가 설정되어 있지 않습니다. 조건을 직접 입력해 주세요.",
          });
        }
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ ok: false, error: "잘못된 요청입니다." }, { status: 400 });
        }
        const file = form.get("image");
        if (
          !(file instanceof File) ||
          file.size === 0 ||
          !ALLOWED.has(file.type) ||
          file.size > MAX_BYTES
        ) {
          return Response.json(
            { ok: false, error: "이미지를 읽을 수 없습니다(3.5MB 이하 jpg/png/webp)." },
            { status: 400 },
          );
        }
        const data = toBase64(await file.arrayBuffer());

        const call = (model: string) =>
          fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY as string,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: 2000,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image", source: { type: "base64", media_type: file.type, data } },
                    { type: "text", text: EXTRACT_PROMPT },
                  ],
                },
              ],
            }),
          });

        try {
          let res = await call(EXTRACT_MODEL);
          let model = EXTRACT_MODEL;
          if (res.status === 404 || res.status === 400) {
            // 모델 이름이 계정에서 지원되지 않는 경우 등 → 대체 모델로 1회 재시도
            res = await call(EXTRACT_FALLBACK_MODEL);
            model = EXTRACT_FALLBACK_MODEL;
          }
          if (!res.ok) {
            console.error("promo-extract upstream", res.status, (await res.text()).slice(0, 300));
            return Response.json({
              ok: false,
              error: `AI 호출 실패(${res.status}). 조건을 직접 입력해 주세요.`,
            });
          }
          const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
          const text = (body.content ?? [])
            .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
            .join("");
          return Response.json({ ...parseExtractResponse(text), model });
        } catch (e) {
          console.error("promo-extract failed", e);
          return Response.json({
            ok: false,
            error: "AI 호출 중 오류가 났습니다. 조건을 직접 입력해 주세요.",
          });
        }
      },
    },
  },
});
