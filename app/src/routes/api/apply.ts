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
        const db = bindings().DB;
        if (!db) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        try {
          await db
            .prepare(
              "INSERT INTO applications (id, name, phone, area, bike, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              crypto.randomUUID(),
              name,
              phone,
              area,
              bike,
              message,
              source,
              new Date().toISOString(),
            )
            .run();
        } catch {
          return Response.json({ ok: false, code: "db_error" }, { status: 500 });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
