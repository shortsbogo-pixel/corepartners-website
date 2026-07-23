import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function label(source: string): string {
  if (source === "coupang-plus") return "라이더지원";
  if (source === "홈-문의") return "문의";
  return source || "-";
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
          return new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const type = url.searchParams.get("type") ?? "all"; // all | rider | inquiry
        const wantExport = url.searchParams.get("export") === "csv";
        const db = bindings().DB;

        const srcFor = (t: string) => (t === "rider" ? "coupang-plus" : t === "inquiry" ? "홈-문의" : null);
        const filterSrc = srcFor(type);

        let rows: Record<string, unknown>[] = [];
        let cRider = 0, cInq = 0, cAll = 0;
        if (db) {
          const base = "SELECT name, phone, area, bike, message, source, created_at FROM applications";
          const q = filterSrc
            ? db.prepare(base + " WHERE source = ? ORDER BY created_at DESC LIMIT 1000").bind(filterSrc)
            : db.prepare(base + " ORDER BY created_at DESC LIMIT 1000");
          const r = await q.all();
          rows = (r.results ?? []) as Record<string, unknown>[];
          const counts = await db
            .prepare("SELECT source, COUNT(*) as n FROM applications GROUP BY source")
            .all();
          for (const c of (counts.results ?? []) as Record<string, unknown>[]) {
            const n = Number(c.n) || 0; cAll += n;
            if (c.source === "coupang-plus") cRider += n;
            else if (c.source === "홈-문의") cInq += n;
          }
        }

        if (wantExport) {
          const header = ["접수일시", "구분", "이름", "연락처", "희망지역/문의유형", "이륜차", "메시지", "출처"];
          const lines = [header.join(",")];
          for (const x of rows) {
            lines.push([
              x.created_at, label(String(x.source ?? "")), x.name, x.phone, x.area, x.bike, x.message, x.source,
            ].map(csvCell).join(","));
          }
          const csv = "﻿" + lines.join("\r\n");
          const fname = `corepartners_${type}_applications.csv`;
          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${fname}"`,
            },
          });
        }

        const tab = (t: string, name: string, n: number) =>
          `<a class="tab${t === type ? " on" : ""}" href="/admin?key=${encodeURIComponent(key)}&type=${t}">${name} <b>${n}</b></a>`;
        const trs = rows
          .map((x) => {
            const tg = label(String(x.source ?? ""));
            const cls = x.source === "coupang-plus" ? "rider" : x.source === "홈-문의" ? "inq" : "";
            return `<tr><td class="dt">${esc(x.created_at)}</td><td><span class="pill ${cls}">${esc(tg)}</span></td><td><b>${esc(x.name)}</b></td><td>${esc(x.phone)}</td><td>${esc(x.area)}</td><td>${esc(x.bike)}</td><td>${esc(x.message)}</td></tr>`;
          })
          .join("");
        const expHref = `/admin?key=${encodeURIComponent(key)}&type=${type}&export=csv`;
        const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>지원·문의 접수 관리 · 코아파트너스</title><style>
body{font-family:system-ui,'Malgun Gothic',sans-serif;background:#0b1a38;color:#eef3fc;margin:0;padding:22px}
h1{font-size:20px;margin:0 0 4px}
.c{color:#8b9cbe;font-size:13px;margin:0 0 16px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.tab{font-size:13px;font-weight:700;color:#c5d5ef;background:#152a4e;border:1px solid #26436f;padding:9px 15px;border-radius:999px;text-decoration:none}
.tab.on{background:linear-gradient(135deg,#4f8dff,#2563eb);color:#fff;border-color:transparent}
.tab b{opacity:.8;font-weight:800}
.dl{margin-left:auto;font-size:13px;font-weight:800;color:#0a1730;background:linear-gradient(135deg,#fde68a,#fbbf24);padding:10px 16px;border-radius:10px;text-decoration:none}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #26436f;padding:9px 11px;text-align:left;vertical-align:top}
th{background:#152a4e;position:sticky;top:0}
tr:nth-child(even){background:rgba(255,255,255,.03)}
td b{color:#fff}
td.dt{white-space:nowrap;color:#9fb2d4;font-variant-numeric:tabular-nums}
.pill{font-size:11px;font-weight:800;padding:3px 9px;border-radius:6px;white-space:nowrap}
.pill.rider{background:rgba(52,211,153,.16);color:#5ff0b0}
.pill.inq{background:rgba(125,180,255,.16);color:#a9cbff}
</style></head><body>
<h1>🛵 지원·문의 접수 관리</h1>
<p class="c">최근순 · 최대 1,000건 · 자동 새로고침 없음</p>
<div class="bar">
${tab("all", "전체", cAll)}
${tab("rider", "라이더지원", cRider)}
${tab("inquiry", "문의", cInq)}
<a class="dl" href="${expHref}">⬇ 엑셀(CSV) 내려받기</a>
</div>
<table><thead><tr><th>접수일시</th><th>구분</th><th>이름/상호</th><th>연락처</th><th>지역/문의유형</th><th>이륜차</th><th>메시지</th></tr></thead>
<tbody>${trs || '<tr><td colspan="7" style="text-align:center;color:#8b9cbe;padding:30px">해당 항목이 없습니다.</td></tr>'}</tbody></table>
</body></html>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    },
  },
});
