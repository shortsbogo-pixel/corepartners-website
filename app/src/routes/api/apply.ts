import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";

export const Route = createFileRoute("/api/apply")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let data: Record<string, unknown> = {};
        try {
          data = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ ok: false, code: "bad_json" }, { status: 400 });
        }
        const s = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
        const name = s(data.name, 60);
        const phone = s(data.phone, 30);
        if (!name || !phone) {
          return Response.json({ ok: false, code: "missing" }, { status: 400 });
        }
        const area = s(data.area, 80);
        const bike = s(data.bike, 20);
        const message = s(data.message, 1000);
        const source = s(data.source, 40);
        const createdAt = new Date().toISOString();
        const db = bindings().DB;
        if (!db) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        try {
          await db
            .prepare(
              "INSERT INTO applications (id, name, phone, area, bike, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(crypto.randomUUID(), name, phone, area, bike, message, source, createdAt)
            .run();
        } catch {
          return Response.json({ ok: false, code: "db_error" }, { status: 500 });
        }

        // Best-effort instant email notification (never blocks the submission).
        try {
          await fetch("https://formsubmit.co/ajax/shortsbogo@gmail.com", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              _subject: `🛵 [코어파트너스] 새 라이더 지원 · ${name}`,
              _template: "table",
              이름: name,
              연락처: phone,
              희망지역: area || "-",
              이륜차: bike || "-",
              메시지: message || "-",
              출처: source || "-",
              접수일시: createdAt,
            }),
          });
        } catch {
          // email failed — the application is still safely stored in the DB
        }

        return Response.json({ ok: true });
      },
    },
  },
});
