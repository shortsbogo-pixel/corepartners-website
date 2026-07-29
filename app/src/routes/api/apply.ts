import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";

// Single ingestion point for all applications/inquiries.
// - Server-side validation & sanitization
// - Duplicate suppression: same phone within 10 minutes -> 409 { code: "dup" }
// - No third-party relay: data is stored in D1 only; staff review via /admin
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
        // honeypot: real forms never fill this
        if (String(data.website ?? "").trim() !== "") {
          return Response.json({ ok: true });
        }
        const clean = (v: unknown, n: number) =>
          String(v ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .trim()
            .slice(0, n);
        const name = clean(data.name, 60);
        const phone = clean(data.phone, 30);
        if (!name || !phone) {
          return Response.json({ ok: false, code: "missing" }, { status: 400 });
        }
        const digits = phone.replace(/\D/g, "");
        if (digits.length < 9 || digits.length > 11) {
          return Response.json({ ok: false, code: "bad_phone" }, { status: 400 });
        }
        const area = clean(data.area, 80);
        const bike = clean(data.bike, 20);
        const message = clean(data.message, 1000);
        const source = clean(data.source, 40);
        // 한국시간(KST)으로 저장 — 관리자 화면·챗봇 로그와 시간대를 통일한다
        const kstIso = (t: number) => new Date(t + 9 * 3600 * 1000).toISOString().replace("Z", "+09:00");
        const createdAt = kstIso(Date.now());
        const db = bindings().DB;
        if (!db) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        try {
          const tenMinAgo = kstIso(Date.now() - 10 * 60 * 1000);
          const dup = await db
            .prepare(
              "SELECT COUNT(*) AS c FROM applications WHERE replace(replace(phone,'-',''),' ','') = ? AND created_at > ?",
            )
            .bind(digits, tenMinAgo)
            .first<{ c: number }>();
          if (dup && Number(dup.c) > 0) {
            return Response.json({ ok: false, code: "dup" }, { status: 409 });
          }
          await db
            .prepare(
              "INSERT INTO applications (id, name, phone, area, bike, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(crypto.randomUUID(), name, phone, area, bike, message, source, createdAt)
            .run();
        } catch {
          return Response.json({ ok: false, code: "db_error" }, { status: 500 });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
