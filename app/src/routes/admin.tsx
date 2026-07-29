import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// 저장값이 UTC(...Z)든 KST(+09:00)든 항상 한국시간으로 표시한다
function kst(v: unknown): string {
  const raw = String(v ?? "");
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}
const STATUSES = ["미처리", "연락함", "완료", "보류"] as const;
function label(source: string): string {
  if (source === "coupang-plus") return "라이더지원";
  if (source === "홈-문의") return "문의";
  return source || "-";
}

export const Route = createFileRoute("/admin")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") ?? "";
        const env = bindings() as unknown as { ADMIN_KEY?: string };
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Unauthorized", { status: 401 });
        const db = bindings().DB;
        const form = await request.formData();
        const id = String(form.get("id") ?? "");
        const action = String(form.get("action") ?? "");
        const back = String(form.get("back") ?? `/admin?key=${encodeURIComponent(key)}`);
        if (db && id) {
          try {
            await db.prepare("ALTER TABLE applications ADD COLUMN status TEXT").run();
          } catch { /* 이미 있으면 통과 */ }
          try {
            await db.prepare("ALTER TABLE applications ADD COLUMN memo TEXT").run();
          } catch { /* 이미 있으면 통과 */ }
          try {
            if (action === "delete") {
              await db.prepare("DELETE FROM applications WHERE id = ?").bind(id).run();
            } else {
              const st = String(form.get("status") ?? "미처리");
              const memo = String(form.get("memo") ?? "").slice(0, 200);
              await db.prepare("UPDATE applications SET status = ?, memo = ? WHERE id = ?").bind(st, memo, id).run();
            }
          } catch { /* best effort */ }
        }
        return new Response(null, { status: 303, headers: { Location: back } });
      },
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
        const stFilter = url.searchParams.get("st") ?? "";           // 접수 상태 필터
        const chatTopic = url.searchParams.get("ctopic") ?? "";        // 주제 필터
        const chatDays = Math.min(Math.max(Number(url.searchParams.get("cdays") ?? 7) || 7, 1), 90);
        const chatFlagOnly = url.searchParams.get("cflag") === "1";
        const chatPage = Math.max(Number(url.searchParams.get("cpage") ?? 1) || 1, 1);
        const wantChatCsv = url.searchParams.get("cexport") === "csv";
        const CHAT_PER = 50;
        const db = bindings().DB;

        const srcFor = (t: string) => (t === "rider" ? "coupang-plus" : t === "inquiry" ? "홈-문의" : null);
        const filterSrc = srcFor(type);

        let rows: Record<string, unknown>[] = [];
        let cRider = 0, cInq = 0, cAll = 0;
        if (db) {
          const base = "SELECT id, name, phone, area, bike, message, source, created_at, status, memo FROM applications";
          const w: string[] = []; const b: unknown[] = [];
          if (filterSrc) { w.push("source = ?"); b.push(filterSrc); }
          if (stFilter === "미처리") w.push("(status IS NULL OR status = '' OR status = '미처리')");
          else if (stFilter) { w.push("status = ?"); b.push(stFilter); }
          const sql = base + (w.length ? " WHERE " + w.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT 1000";
          try {
            const r = await db.prepare(sql).bind(...b).all();
            rows = (r.results ?? []) as Record<string, unknown>[];
          } catch {
            // status/memo 컬럼이 아직 없으면 만들고 다시 조회한다
            try { await db.prepare("ALTER TABLE applications ADD COLUMN status TEXT").run(); } catch { /* noop */ }
            try { await db.prepare("ALTER TABLE applications ADD COLUMN memo TEXT").run(); } catch { /* noop */ }
            try {
              const r2 = await db.prepare(sql).bind(...b).all();
              rows = (r2.results ?? []) as Record<string, unknown>[];
            } catch { rows = []; }
          }
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
          const header = ["접수일시(KST)", "구분", "상태", "이름", "연락처", "희망지역/문의유형", "이륜차", "메시지", "메모", "출처"];
          const lines = [header.join(",")];
          for (const x of rows) {
            lines.push([
              kst(x.created_at), label(String(x.source ?? "")), x.status || "미처리", x.name, x.phone, x.area, x.bike, x.message, x.memo, x.source,
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
        const backHref = url.pathname + url.search;
        const stKey = (v: unknown) => { const t = String(v ?? "").trim(); return STATUSES.includes(t as typeof STATUSES[number]) ? t : "미처리"; };
        const trs = rows
          .map((x) => {
            const tg = label(String(x.source ?? ""));
            const cls = x.source === "coupang-plus" ? "rider" : x.source === "홈-문의" ? "inq" : "";
            const cur = stKey(x.status);
            const opts = STATUSES.map((o) => `<option value="${o}"${o === cur ? " selected" : ""}>${o}</option>`).join("");
            const idv = esc(x.id);
            return `<tr class="st-${cur === "미처리" ? "todo" : cur === "완료" ? "done" : cur === "연락함" ? "call" : "hold"}">
<td class="dt">${esc(kst(x.created_at))}</td>
<td><span class="pill ${cls}">${esc(tg)}</span></td>
<td><b>${esc(x.name)}</b></td><td>${esc(x.phone)}</td><td>${esc(x.area)}</td><td>${esc(x.bike)}</td><td>${esc(x.message)}</td>
<td class="stc">
<form method="post" action="/admin?key=${encodeURIComponent(key)}" class="stf">
<input type="hidden" name="id" value="${idv}"><input type="hidden" name="back" value="${esc(backHref)}">
<select name="status">${opts}</select>
<input type="text" name="memo" value="${esc(x.memo)}" placeholder="메모" maxlength="200">
<button type="submit">저장</button>
</form>
<form method="post" action="/admin?key=${encodeURIComponent(key)}" class="stf" onsubmit="return confirm('이 접수를 삭제할까요? 되돌릴 수 없습니다.')">
<input type="hidden" name="id" value="${idv}"><input type="hidden" name="action" value="delete"><input type="hidden" name="back" value="${esc(backHref)}">
<button type="submit" class="del">삭제</button>
</form>
</td></tr>`;
          })
          .join("");
        const stq = (v: string) => {
          const sp = new URLSearchParams({ key });
          if (type !== "all") sp.set("type", type);
          if (v) sp.set("st", v);
          return "/admin?" + sp.toString();
        };
        const stChips = ["", "미처리", "연락함", "완료", "보류"]
          .map((v) => `<a class="ct sm${stFilter === v ? " on" : ""}" href="${stq(v)}">${v || "전체 상태"}</a>`)
          .join(" ");
        const expHref = `/admin?key=${encodeURIComponent(key)}&type=${type}&export=csv`;
        // ---- AI chatbot logs (masked) ----
        let chatTopics: Array<{ topic: string; n: number }> = [];
        let chatFlagged = 0;
        let gapTopics: Array<{ topic: string; n: number }> = [];
        let gapRows: Array<{ at: string; topic: string; q: string | null }> = [];
        let chatTotal = 0;
        let chatRows: Array<{ created_at: string; role: string; topic: string; flagged: number; content: string }> = [];
        const cWhere: string[] = [];
        const cBind: unknown[] = [];
        const sinceIso = new Date(Date.now() - chatDays * 86400 * 1000 + 9 * 3600 * 1000).toISOString();
        cWhere.push("created_at >= ?"); cBind.push(sinceIso);
        if (chatTopic) { cWhere.push("topic = ?"); cBind.push(chatTopic); }
        if (chatFlagOnly) { cWhere.push("flagged = 1"); }
        const cW = cWhere.length ? " WHERE " + cWhere.join(" AND ") : "";
        try {
          if (db) {
            chatTopics = ((await db
              .prepare("SELECT topic, COUNT(*) AS n FROM chat_logs WHERE role = 'user' AND created_at >= ? GROUP BY topic ORDER BY n DESC")
              .bind(sinceIso)
              .all()).results ?? []) as Array<{ topic: string; n: number }>;
            const fl = await db
              .prepare("SELECT COUNT(*) AS c FROM chat_logs WHERE flagged = 1 AND created_at >= ?")
              .bind(sinceIso)
              .first<{ c: number }>();
            chatFlagged = fl ? Number(fl.c) : 0;
            gapTopics = ((await db
              .prepare("SELECT topic, COUNT(*) AS n FROM chat_logs WHERE flagged = 1 AND created_at >= ? GROUP BY topic ORDER BY n DESC LIMIT 6")
              .bind(sinceIso)
              .all()).results ?? []) as Array<{ topic: string; n: number }>;
            gapRows = ((await db
              .prepare(
                "SELECT a.created_at AS at, a.topic AS topic, " +
                "(SELECT u.content FROM chat_logs u WHERE u.session = a.session AND u.role = 'user' AND u.created_at <= a.created_at ORDER BY u.created_at DESC LIMIT 1) AS q " +
                "FROM chat_logs a WHERE a.flagged = 1 AND a.created_at >= ? ORDER BY a.created_at DESC LIMIT 25"
              )
              .bind(sinceIso)
              .all()).results ?? []) as Array<{ at: string; topic: string; q: string | null }>;
            const tot = await db
              .prepare("SELECT COUNT(*) AS c FROM chat_logs" + cW)
              .bind(...cBind)
              .first<{ c: number }>();
            chatTotal = tot ? Number(tot.c) : 0;
            const lim = wantChatCsv ? 5000 : CHAT_PER;
            const off = wantChatCsv ? 0 : (chatPage - 1) * CHAT_PER;
            chatRows = ((await db
              .prepare("SELECT created_at, role, topic, flagged, content FROM chat_logs" + cW + " ORDER BY created_at DESC LIMIT ? OFFSET ?")
              .bind(...cBind, lim, off)
              .all()).results ?? []) as Array<{ created_at: string; role: string; topic: string; flagged: number; content: string }>;
          }
        } catch { /* table may not exist yet */ }

        if (wantChatCsv) {
          const header = ["일시", "구분", "주제", "전화안내", "내용(마스킹)"];
          const lines = [header.join(",")];
          for (const r of chatRows) {
            lines.push([
              r.created_at, r.role === "user" ? "질문" : "답변", r.topic ?? "", r.flagged ? "전화안내" : "", r.content,
            ].map(csvCell).join(","));
          }
          const csv = "\ufeff" + lines.join("\r\n");
          const tag = chatTopic ? chatTopic.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/g, "") : (chatFlagOnly ? "phone-guided" : "all");
          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="corepartners_chatlogs_${tag}_${chatDays}d.csv"`,
            },
          });
        }
        const cq = (o: Record<string, string | number>) => {
          const sp = new URLSearchParams({ key });
          if (type !== "all") sp.set("type", type);
          const merged: Record<string, string | number> = { ctopic: chatTopic, cdays: chatDays, cflag: chatFlagOnly ? 1 : 0, cpage: chatPage, ...o };
          for (const [k, v] of Object.entries(merged)) {
            if (v === "" || v === 0 || (k === "cpage" && v === 1) || (k === "cdays" && v === 7)) continue;
            sp.set(k, String(v));
          }
          return "/admin?" + sp.toString() + "#chatlog";
        };
        const chip = (labelTxt: string, active: boolean, href: string, n?: number) =>
          `<a class="ct${active ? " on" : ""}" href="${href}"><b>${esc(labelTxt)}</b>${n === undefined ? "" : ` ${n}건`}</a>`;
        const chatTopicHtml = [
          chip("전체", !chatTopic && !chatFlagOnly, cq({ ctopic: "", cflag: 0, cpage: 1 })),
          ...chatTopics.map((r) => chip(r.topic ?? "기타", chatTopic === r.topic, cq({ ctopic: r.topic ?? "", cflag: 0, cpage: 1 }), r.n)),
          chip("📞 전화 안내", chatFlagOnly, cq({ ctopic: "", cflag: 1, cpage: 1 }), chatFlagged),
        ].join(" ");
        const dayHtml = [7, 30, 90]
          .map((d) => `<a class="ct sm${chatDays === d ? " on" : ""}" href="${cq({ cdays: d, cpage: 1 })}">${d}일</a>`)
          .join(" ");
        const chatPages = Math.max(Math.ceil(chatTotal / CHAT_PER), 1);
        const pagerHtml =
          chatPages > 1
            ? `<div class="pager">${chatPage > 1 ? `<a class="ct sm" href="${cq({ cpage: chatPage - 1 })}">‹ 이전</a>` : ""}<span class="pg">${chatPage} / ${chatPages} 쪽 · 총 ${chatTotal}건</span>${chatPage < chatPages ? `<a class="ct sm" href="${cq({ cpage: chatPage + 1 })}">다음 ›</a>` : ""}</div>`
            : `<div class="pager"><span class="pg">총 ${chatTotal}건</span></div>`;
        const chatCsvHref = cq({ cexport: "csv" }).replace("#chatlog", "");
        const chatTrs = chatRows
          .map((r) => `<tr class="${r.role === 'user' ? 'cu' : ''}${r.flagged ? ' cf' : ''}"><td>${esc(String(r.created_at ?? '').slice(5, 16).replace('T', ' '))}</td><td>${r.role === 'user' ? '👤 질문' : '🤖 답변'}</td><td>${esc(r.topic ?? '-')}</td><td>${r.flagged ? '📞 전화 안내' : ''}</td><td class="cc">${esc(r.content)}</td></tr>`)
          .join("");
        const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>지원·문의 접수 관리 · 코아파트너스</title><style>
body{font-family:system-ui,'Malgun Gothic',sans-serif;background:#0b1a38;color:#eef3fc;margin:0;padding:22px}
h1{font-size:20px;margin:0 0 4px}
.c{color:#8b9cbe;font-size:13px;margin:0 0 16px}
.gap{background:#122a52;border:1px solid #1f3f74;border-radius:12px;padding:14px 16px;margin:12px 0 6px}
.gap-h{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.gap-h b{font-size:15px}
.gap-r{font-size:13px;font-weight:800}
.gap-t{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.gt{background:#0b1a38;border:1px solid #274a86;border-radius:999px;padding:4px 10px;font-size:12px;color:#c7d6f0}
.gt b{color:#fbbf24}
.gq{margin:0;padding-left:20px;max-height:230px;overflow:auto}
.gq li{font-size:13px;line-height:1.55;margin-bottom:5px;color:#e3ecfb}
.gq-t{display:inline-block;background:#0b1a38;border-radius:5px;padding:1px 6px;margin-right:7px;font-size:11px;color:#8fa8d4}
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
td.stc{white-space:nowrap;min-width:250px}
.stf{display:flex;gap:5px;align-items:center;margin:0 0 5px}
.stf select,.stf input[type=text]{background:#0f2244;border:1px solid #26436f;border-radius:7px;color:#e8f0ff;padding:6px 8px;font-size:12px;font-family:inherit}
.stf input[type=text]{width:120px}
.stf button{background:#2563eb;border:none;color:#fff;font-weight:800;font-size:12px;padding:6px 11px;border-radius:7px;cursor:pointer;font-family:inherit}
.stf button.del{background:transparent;border:1px solid #7f3550;color:#f0a0b4;font-weight:700}
.stf button.del:hover{background:#7f3550;color:#fff}
tr.st-todo td:first-child{border-left:3px solid #fbbf24}
tr.st-call td:first-child{border-left:3px solid #4f8dff}
tr.st-done td:first-child{border-left:3px solid #34d399}
tr.st-done td{opacity:.62}
tr.st-hold td:first-child{border-left:3px solid #8b9cbe}
.promo-box{background:#152a4e;border:1px solid #26436f;border-radius:12px;padding:16px 18px;margin:0 0 18px}
.promo-box h2{font-size:15px;margin:0 0 6px}
.promo-box form{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0 12px}
.promo-box input[type=file]{font-size:13px;color:#c5d5ef}
.promo-box button{font-size:13px;font-weight:800;color:#0a1730;background:linear-gradient(135deg,#fde68a,#fbbf24);border:none;padding:10px 16px;border-radius:9px;cursor:pointer}
.promo-prev{max-width:260px;border-radius:9px;border:1px solid #26436f;display:block}
.ct{display:inline-block;background:#0f2244;border:1px solid #26436f;border-radius:999px;padding:6px 12px;margin:0 6px 6px 0;font-size:12.5px;color:#c5d5ef;text-decoration:none}
.ct b{color:#fde68a}
.ct:hover{background:#173a6e}
.ct.on{background:#c9930a;border-color:#c9930a;color:#fff}
.ct.on b{color:#fff}
.ct.sm{font-size:11.5px;padding:5px 10px}
.pager{display:flex;align-items:center;gap:10px;margin:12px 0 4px}
.pg{font-size:12px;color:#8b9cbe}
tr.cu td{background:#13284c}
tr.cf td{border-left:none}
tr.cf td:first-child{border-left:3px solid #fbbf24}
td.cc{max-width:520px;word-break:break-all;color:#c5d5ef;font-size:12px}
</style></head><body>
<h1>🛵 지원·문의 접수 관리</h1>
<p class="c">최근순 · 최대 1,000건 · 시각은 한국시간(KST) · 상태와 메모는 저장 버튼을 눌러야 반영됩니다 · CSV에는 개인정보가 그대로 담기니 내려받은 파일은 따로 관리하세요</p>
<div class="promo-box">
<h2>📢 이번주 쿠팡플러스미션 배너 교체</h2>
<p class="c">${url.searchParams.get("promo") === "ok" ? '<b style="color:#5ff0b0">✔ 배너가 교체되었습니다. 사이트에 즉시 반영됩니다.</b>' : "webp / png / jpg · 최대 5MB · 주차 라벨과 적용 기간(시작·종료일)을 함께 입력하면 페이지의 기간 표시도 같이 갱신됩니다."}</p>
<form method="post" enctype="multipart/form-data" action="/api/promo-upload?key=${encodeURIComponent(key)}">
<input type="file" name="banner" accept="image/webp,image/png,image/jpeg" required>
<input type="text" name="label" placeholder="주차 라벨 (예: 2026년 7월 5주차 프로모션)" maxlength="60" style="flex:1;min-width:240px;background:#0f2244;border:1px solid #26436f;border-radius:8px;color:#e8f0ff;padding:9px 11px;font-size:13px">
<label style="font-size:12px;color:#8fa3c8">시작 <input type="date" name="start" style="background:#0f2244;border:1px solid #26436f;border-radius:8px;color:#e8f0ff;padding:8px;font-size:13px"></label>
<label style="font-size:12px;color:#8fa3c8">종료 <input type="date" name="end" style="background:#0f2244;border:1px solid #26436f;border-radius:8px;color:#e8f0ff;padding:8px;font-size:13px"></label>
<button type="submit">배너 업로드</button>
</form>
<p class="c">현재 배너 미리보기:</p>
<img class="promo-prev" src="/promo-banner?t=${Date.now()}" alt="현재 프로모션 배너">
</div>
<div class="bar">
${tab("all", "전체", cAll)}
${tab("rider", "라이더지원", cRider)}
${tab("inquiry", "문의", cInq)}
<a class="dl" href="${expHref}">⬇ 엑셀(CSV) 내려받기</a>
</div>
<div style="margin:0 0 10px">${stChips}</div>
<table><thead><tr><th>접수일시</th><th>구분</th><th>이름/상호</th><th>연락처</th><th>지역/문의유형</th><th>이륜차</th><th>메시지</th><th>상태 · 메모</th></tr></thead>
<tbody>${trs || '<tr><td colspan="8" style="text-align:center;color:#8b9cbe;padding:30px">해당 항목이 없습니다.</td></tr>'}</tbody></table>

<h1 id="chatlog" style="margin-top:34px">💬 AI 챗봇 대화 로그</h1>
<p class="c">최근 7일 문의 주제 분포 · 개인정보(전화번호 등)는 마스킹 저장 · 📞 전화 안내 = 답변 끝에 대표번호 안내가 붙은 답변(답변 실패가 아님) ${chatFlagged ? `· <b style="color:#fbbf24">전화 안내 ${chatFlagged}건</b>` : ""}</p>
${(() => {
  const totalQ = chatTopics.reduce((a, r) => a + Number(r.n || 0), 0);
  const pct = totalQ ? Math.round((chatFlagged / totalQ) * 1000) / 10 : 0;
  const tone = pct >= 40 ? "#f87171" : pct >= 25 ? "#fbbf24" : "#4ade80";
  const topicLine = gapTopics.length
    ? gapTopics.map((r) => `<span class="gt">${esc(r.topic || "기타")} <b>${r.n}</b></span>`).join(" ")
    : `<span class="c" style="font-size:12px">막힌 주제 없음</span>`;
  const qList = gapRows.length
    ? gapRows.map((r) => `<li><span class="gq-t">${esc(r.topic || "기타")}</span>${esc((r.q || "(질문 기록 없음)").slice(0, 120))}</li>`).join("")
    : `<li style="color:#8b9cbe">아직 전화로 넘긴 질문이 없습니다.</li>`;
  return `<div class="gap">
  <div class="gap-h"><b>📞 전화로 넘긴 질문 리포트</b><span class="gap-r" style="color:${tone}">전화 안내 ${chatFlagged}건 / 질문 ${totalQ}건 · ${pct}%</span></div>
  <p class="c" style="margin:0 0 9px;font-size:12px">챗봇이 답변 끝에 대표번호 안내를 붙인 질문들입니다. <b>답변 실패가 아니라 "챗봇 선에서 끝내지 못한 질문"</b>이라는 뜻이에요. 같은 질문이 반복되면 그 주제를 더 확실히 답할 수 있게 보완하면 됩니다. 질문이 30건 미만일 때는 비율이 크게 흔들리니 숫자보다 아래 질문 내용을 보세요.</p>
  <div class="gap-t">${topicLine}</div>
  <ol class="gq">${qList}</ol>
</div>`;
})()}
<div style="margin:10px 0 6px">${chatTopicHtml}</div>
<div style="margin:0 0 10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
  <span class="c" style="font-size:12px">기간</span>${dayHtml}
  <a class="dl" href="${chatCsvHref}">⬇ 엑셀(CSV) 내려받기</a>
</div>
${pagerHtml}
<table><thead><tr><th>일시</th><th>구분</th><th>주제</th><th></th><th>내용(마스킹)</th></tr></thead>
<tbody>${chatTrs || '<tr><td colspan="5" style="text-align:center;color:#8b9cbe;padding:26px">챗봇 활성화 후 대화가 여기에 쌓입니다. (주 1회 훑어보고 자주 묻는 주제를 지식에 보강하세요)</td></tr>'}</tbody></table>
${pagerHtml}
</body></html>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    },
  },
});
