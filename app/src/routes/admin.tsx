import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const Route = createFileRoute("/admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") ?? "";
        const env = bindings() as unknown as { ADMIN_KEY?: string };
        const adminKey = env.ADMIN_KEY ?? "";
        if (!adminKey || key !== adminKey) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        const db = bindings().DB;
        let rows: Record<string, unknown>[] = [];
        if (db) {
          const r = await db
            .prepare(
              "SELECT name, phone, area, bike, message, source, created_at FROM applications ORDER BY created_at DESC LIMIT 500",
            )
            .all();
          rows = (r.results ?? []) as Record<string, unknown>[];
        }
        const trs = rows
          .map(
            (x) =>
              `<tr><td>${esc(x.created_at)}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.phone)}</td><td>${esc(x.area)}</td><td>${esc(x.bike)}</td><td>${esc(x.message)}</td><td>${esc(x.source)}</td></tr>`,
          )
          .join("");
        const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>지원 접수 관리 · 코어파트너스</title><style>body{font-family:system-ui,'Malgun Gothic',sans-serif;background:#0b1a38;color:#eef3fc;margin:0;padding:24px}h1{font-size:20px}p.c{color:#8b9cbe;font-size:13px;margin:6px 0 18px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #26436f;padding:8px 10px;text-align:left;vertical-align:top}th{background:#152a4e;position:sticky;top:0}tr:nth-child(even){background:rgba(255,255,255,.03)}td b{color:#fff}</style></head><body><h1>🛵 라이더 지원 접수 <span style="color:#7db4ff">(${rows.length})</span></h1><p class="c">최근순 · 최대 500건</p><table><thead><tr><th>접수일시</th><th>이름</th><th>연락처</th><th>희망지역</th><th>이륜차</th><th>메시지</th><th>출처</th></tr></thead><tbody>${trs || '<tr><td colspan="7" style="text-align:center;color:#8b9cbe;padding:30px">아직 접수된 지원이 없습니다.</td></tr>'}</tbody></table></body></html>`;
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  },
});
