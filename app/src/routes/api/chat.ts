import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { CHAT_MODEL, MAX_TOKENS, SYSTEM_PROMPT } from "../../lib/chatbot.server";

type Msg = { role: "user" | "assistant"; content: string };

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_MAX = 20;
const DAILY_MAX = 300; // daily usage cap (user turns) — cost guard

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

function kstDayPrefix(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function dailyCapped(): Promise<boolean> {
  try {
    const db = bindings().DB;
    if (!db) return false;
    const row = await db
      .prepare("SELECT COUNT(*) AS c FROM chat_logs WHERE role = 'user' AND created_at LIKE ?")
      .bind(kstDayPrefix() + "%")
      .first<{ c: number }>();
    return !!row && Number(row.c) >= DAILY_MAX;
  } catch {
    return false;
  }
}

// privacy: mask phone-like and RRN-like digit runs before persisting
// 회사 공개 번호(대표문의·센터)는 개인정보가 아니므로 마스킹에서 제외한다.
const PUBLIC_TELS = ["042-672-0901", "042-672-0777"];
function mask(s: string): string {
  const keep: string[] = [];
  let t = s;
  // 1) 공개 번호를 자리표시자로 빼둔다 (하이픈 없는 표기까지 함께 처리)
  for (const tel of PUBLIC_TELS) {
    const bare = tel.replace(/-/g, "");
    for (const form of [tel, bare]) {
      let i = t.indexOf(form);
      while (i !== -1) {
        const token = "\u0000T" + keep.length + "\u0000";
        keep.push(tel);
        t = t.slice(0, i) + token + t.slice(i + form.length);
        i = t.indexOf(form);
      }
    }
  }
  // 2) 나머지 개인 연락처·주민번호를 마스킹
  t = t
    .replace(/\d{6}[-\s]?\d{7}/g, "******-*******")
    .replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, "0**-****-****")
    .replace(/\d{9,11}/g, "***********");
  // 3) 공개 번호를 원래대로 되돌린다
  return t.replace(/\u0000T(\d+)\u0000/g, (_m, i) => keep[Number(i)] ?? "");
}

// widget renders plain text — strip any markdown the model emits
function plain(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1· ")
    .replace(/(^|\n)\s*\d+\.\s+/g, "$1· ")
    .replace(/\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function topicOf(s: string): string {
  if (/(사고|보험|산재|파손|다쳤)/.test(s)) return "사고·보험";
  if (/(렌트|리스|바이크|기종|오토바이|전기|EV|내연)/i.test(s)) return "렌트·리스";
  if (/(수익|미션|정산|콜비|얼마|150만|보상)/.test(s)) return "수익·미션";
  if (/(지원|등록|신청|시작|서류|면허)/.test(s)) return "지원 절차";
  if (/(가맹|입점|가게|사장|배달대행)/.test(s)) return "가맹·입점";
  return "기타";
}

// 개인정보 처리방침상 챗봇 대화 기록 보유기간은 90일.
// 별도 스케줄러 없이, 로그를 쓸 때 낮은 확률로 만료분을 정리한다.
const LOG_RETENTION_DAYS = 90;
async function purgeOldLogs(force = false) {
  if (!force && Math.random() > 0.02) return;
  try {
    const db = bindings().DB;
    if (!db) return;
    const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - LOG_RETENTION_DAYS * 86400 * 1000)
      .toISOString()
      .replace("Z", "+09:00");
    await db.prepare("DELETE FROM chat_logs WHERE created_at < ?").bind(cutoff).run();
  } catch {
    // best-effort
  }
}

async function log(session: string, role: string, topic: string, flagged: number, content: string) {
  try {
    const db = bindings().DB;
    if (!db) return;
    await db
      .prepare("INSERT INTO chat_logs (id, session, role, topic, flagged, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), session, role, topic, flagged, mask(content).slice(0, 800), new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("Z", "+09:00"))
      .run();
  } catch {
    // logging is best-effort
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
        if (await dailyCapped()) {
          return Response.json({
            reply: "오늘 AI 상담이 몰려 잠시 쉬어갑니다. 042-672-0901(평일 10:30~18:00)로 전화 주시면 바로 도와드립니다. {{CALL}}",
          });
        }
        let body: { messages?: Msg[]; session?: string };
        try {
          body = await request.json();
        } catch {
          return Response.json({ reply: "요청 형식이 올바르지 않습니다." }, { status: 400 });
        }
        const session = String(body.session ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 24) || "anon";
        const raw = Array.isArray(body.messages) ? body.messages : [];
        const messages: Msg[] = raw
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
        if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
          return Response.json({ reply: "무엇이 궁금하신가요? 미션, 수익, 렌트, 지원 절차 모두 물어보세요." });
        }
        const userMsg = messages[messages.length - 1].content;
        const topic = topicOf(userMsg);
        await log(session, "user", topic, 0, userMsg);
        await purgeOldLogs();
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
          const clean = plain(reply);
          const flagged = /042-672-0901/.test(reply) && /(문의해 주세요|전화 주세요|전화로 확인)/.test(reply) ? 1 : 0;
          await log(session, "assistant", topic, flagged, clean.replace(/\{\{(APPLY|CALL)\}\}/g, ""));
          return Response.json({ reply: clean });
        } catch {
          return Response.json({
            reply: "지금 상담봇 연결이 원활하지 않아요. 042-672-0901로 전화 주시면 바로 도와드립니다.",
          });
        }
      },
    },
  },
});
