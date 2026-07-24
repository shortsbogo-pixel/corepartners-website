import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { CHAT_MODEL, MAX_TOKENS, SYSTEM_PROMPT } from "../../lib/chatbot.server";

type Msg = { role: "user" | "assistant"; content: string };

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_MAX = 20;

async function rateLimited(ip: string): Promise<boolean> {
  try {
    const db = bindings().DB;
    if (!db) return false;
    const now = Date.now();
    const row = await db
      .prepare("SELECT window_start, count FROM chat_rate WHERE ip = ?")
      .bind(ip)
      .first<{ window_start: number; count: number }>();
    if (!row || now - row.window_start > WINDOW_MS) {
      await db
        .prepare(
          "INSERT INTO chat_rate (ip, window_start, count) VALUES (?, ?, 1) ON CONFLICT(ip) DO UPDATE SET window_start = ?, count = 1",
        )
        .bind(ip, now, now)
        .run();
      return false;
    }
    if (row.count >= WINDOW_MAX) return true;
    await db.prepare("UPDATE chat_rate SET count = count + 1 WHERE ip = ?").bind(ip).run();
    return false;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      GET: async () => {
        const env = bindings() as unknown as { ANTHROPIC_API_KEY?: string };
        return Response.json({ enabled: Boolean(env.ANTHROPIC_API_KEY) });
      },
      POST: async ({ request }) => {
        const env = bindings() as unknown as { ANTHROPIC_API_KEY?: string };
        if (!env.ANTHROPIC_API_KEY) {
          return Response.json({ reply: "상담봇 준비 중입니다. 042-672-0901로 문의해 주세요." }, { status: 503 });
        }
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        if (await rateLimited(ip)) {
          return Response.json({
            reply: "잠시 요청이 많아요. 몇 분 후 다시 시도하시거나 042-672-0901로 전화 주세요.",
          });
        }
        let body: { messages?: Msg[] };
        try {
          body = await request.json();
        } catch {
          return Response.json({ reply: "요청 형식이 올바르지 않습니다." }, { status: 400 });
        }
        const raw = Array.isArray(body.messages) ? body.messages : [];
        const messages: Msg[] = raw
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
        if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
          return Response.json({ reply: "무엇이 궁금하신가요? 미션, 수익, 렌트, 지원 절차 모두 물어보세요." });
        }
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: CHAT_MODEL,
              max_tokens: MAX_TOKENS,
              system: SYSTEM_PROMPT,
              messages,
            }),
          });
          if (!res.ok) {
            return Response.json({
              reply: "지금 상담봇 연결이 원활하지 않아요. 042-672-0901로 전화 주시면 바로 도와드립니다.",
            });
          }
          const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
          const reply =
            (data.content ?? [])
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("\n")
              .trim() || "죄송해요, 다시 한 번 여쭤봐 주시겠어요?";
          return Response.json({ reply });
        } catch {
          return Response.json({
            reply: "지금 상담봇 연결이 원활하지 않아요. 042-672-0901로 전화 주시면 바로 도와드립니다.",
          });
        }
      },
    },
  },
});
