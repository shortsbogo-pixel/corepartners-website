// 주간 미션 조건(관리자 입력) — 순수 규칙 모듈.
// Workers 모듈을 import 하지 않으므로 `node --test` 로 그대로 검증할 수 있다.
//
// 흐름: 관리자(/admin)가 배너와 함께 조건을 저장 → R2 `mission-config` JSON
//      → /coupang-plus · / · /llms.txt · 챗봇이 요청 시점에 이 값으로 렌더링.
// 저장값이 없거나 깨졌으면 DEFAULT_MISSION_CONFIG(2026-09-23 배너 기준)를 쓴다.

export const MISSION_CONFIG_SCHEMA = 1;

export type Basis = "daily" | "sum"; // daily = 요일마다 개별 집계·지급, sum = 요일 묶음 합산

export type TimedGroup = {
  days: number[]; // 0=일 … 6=토 (JS getDay 순서)
  from: string; // "HH:MM"
  to: string; // "HH:MM" (자정 넘김 없음)
  count: number; // 목표 건수
  pay: number; // 보상(원)
};

export type TimedMission = {
  enabled: boolean;
  basis: Basis;
  groups: TimedGroup[];
  note: string; // 카드에 덧붙이는 짧은 안내(예: 앱 공지 확인 후 참여)
};

export type WeeklyTier = { count: number; total: number }; // total = 해당 단계까지의 누적 보상

export type MissionConfig = {
  schema: number;
  lunch: TimedMission;
  postlunch: TimedMission;
  owl: TimedMission;
  weekly: { tiers: WeeklyTier[] };
  perks: { friend: number; welcomeCount: number; welcomePay: number; gearCount: number };
  rules: { cancelRateMax: number; duplicate: boolean };
};

export const TIMED_KEYS = ["lunch", "postlunch", "owl"] as const;
export type TimedKey = (typeof TIMED_KEYS)[number];

export const MISSION_TITLES: Record<TimedKey, { card: string; board: string; sum: string }> = {
  lunch: { card: "평일런치 미션", board: "평일런치", sum: "평일런치 미션" },
  postlunch: { card: "포스트런치 미션", board: "포스트런치", sum: "포스트런치 미션" },
  owl: { card: "올빼미 미션", board: "야간 올빼미", sum: "올빼미 미션" },
};

/** 2026.09.23(수) ~ 09.29(화) 배너 기준 (사용자 제공 배너). */
export const DEFAULT_MISSION_CONFIG: MissionConfig = {
  schema: MISSION_CONFIG_SCHEMA,
  lunch: {
    enabled: true,
    basis: "daily",
    groups: [{ days: [1, 2, 3, 4, 5], from: "10:55", to: "12:59", count: 8, pay: 8000 }],
    note: "",
  },
  postlunch: {
    enabled: true,
    basis: "daily",
    groups: [
      { days: [1, 2, 3, 4, 5], from: "13:00", to: "16:54", count: 12, pay: 10000 },
      { days: [0, 6], from: "14:00", to: "16:54", count: 12, pay: 10000 },
    ],
    note: "",
  },
  owl: {
    enabled: true,
    basis: "sum",
    groups: [
      { days: [1, 2], from: "21:00", to: "23:59", count: 20, pay: 14000 },
      { days: [3, 4, 5], from: "21:00", to: "23:59", count: 27, pay: 22000 },
      { days: [0, 6], from: "21:00", to: "23:59", count: 22, pay: 16000 },
    ],
    note: "앱 공지 확인 후 참여",
  },
  weekly: {
    tiers: [
      { count: 150, total: 10000 },
      { count: 180, total: 20000 },
      { count: 190, total: 40000 },
      { count: 250, total: 60000 },
      { count: 300, total: 90000 },
      { count: 350, total: 120000 },
    ],
  },
  perks: { friend: 50000, welcomeCount: 150, welcomePay: 30000, gearCount: 100 },
  rules: { cancelRateMax: 10, duplicate: true },
};

// ───────────────────────── 검증 ─────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

function toMin(t: string): number {
  const m = TIME_RE.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function int(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v.replace(/[,\s원건]/g, ""));
  return NaN;
}

function isInt(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

function cleanText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/<[^>]*>/g, "")
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
    .join("")
    .trim()
    .slice(0, max);
}

export type ValidateResult = { ok: true; config: MissionConfig } | { ok: false; errors: string[] };

/**
 * 관리자 입력·AI 추출·R2 저장값 모두 이 함수를 통과해야 쓰인다.
 * 숫자 문자열("8,000")은 숫자로 바꿔 주되, 범위·순서가 틀리면 저장을 막는다.
 */
export function validateMissionConfig(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const timed = {} as Record<TimedKey, TimedMission>;
  for (const key of TIMED_KEYS) {
    const name = MISSION_TITLES[key].card;
    const m = (r[key] && typeof r[key] === "object" ? r[key] : {}) as Record<string, unknown>;
    const enabled = m.enabled !== false;
    const basis: Basis = m.basis === "sum" ? "sum" : "daily";
    const note = cleanText(m.note, 40);
    const groupsRaw = Array.isArray(m.groups) ? m.groups : [];
    const groups: TimedGroup[] = [];
    if (enabled && groupsRaw.length === 0)
      errors.push(`${name}: 요일·시간 줄이 최소 1개 필요합니다.`);
    if (groupsRaw.length > 7) errors.push(`${name}: 줄은 최대 7개까지입니다.`);
    const seen = new Set<number>();
    groupsRaw.slice(0, 7).forEach((gRaw, i) => {
      const g = (gRaw && typeof gRaw === "object" ? gRaw : {}) as Record<string, unknown>;
      const where = `${name} ${i + 1}번째 줄`;
      const days = Array.isArray(g.days)
        ? [...new Set(g.days.map((d) => int(d)))]
            .filter((d) => isInt(d, 0, 6))
            .sort((a, b) => a - b)
        : [];
      if (days.length === 0) errors.push(`${where}: 요일을 1개 이상 선택하세요.`);
      for (const d of days) {
        if (seen.has(d)) errors.push(`${where}: ${DAY_NAMES[d]}요일이 다른 줄과 겹칩니다.`);
        seen.add(d);
      }
      const from = String(g.from ?? "").trim();
      const to = String(g.to ?? "").trim();
      if (!TIME_RE.test(from) || !TIME_RE.test(to))
        errors.push(`${where}: 시간은 00:00~23:59 형식이어야 합니다.`);
      else if (toMin(to) <= toMin(from))
        errors.push(`${where}: 종료 시각이 시작 시각보다 늦어야 합니다.`);
      const count = int(g.count);
      const pay = int(g.pay);
      if (!isInt(count, 1, 999)) errors.push(`${where}: 건수는 1~999 사이 정수여야 합니다.`);
      if (!isInt(pay, 0, 1_000_000))
        errors.push(`${where}: 금액은 0~1,000,000원 사이 정수여야 합니다.`);
      groups.push({ days, from, to, count, pay });
    });
    timed[key] = { enabled, basis, groups, note };
  }

  const w = (r.weekly && typeof r.weekly === "object" ? r.weekly : {}) as Record<string, unknown>;
  const tiersRaw = Array.isArray(w.tiers) ? w.tiers : [];
  const tiers: WeeklyTier[] = [];
  if (tiersRaw.length === 0) errors.push("주간 누적 미션: 단계가 최소 1개 필요합니다.");
  if (tiersRaw.length > 10) errors.push("주간 누적 미션: 단계는 최대 10개까지입니다.");
  tiersRaw.slice(0, 10).forEach((tRaw, i) => {
    const t = (tRaw && typeof tRaw === "object" ? tRaw : {}) as Record<string, unknown>;
    const count = int(t.count);
    const total = int(t.total);
    if (!isInt(count, 1, 3000))
      errors.push(`주간 누적 ${i + 1}단계: 건수는 1~3000 사이 정수여야 합니다.`);
    if (!isInt(total, 1, 5_000_000))
      errors.push(`주간 누적 ${i + 1}단계: 누적 금액은 1~5,000,000원 사이 정수여야 합니다.`);
    const prev = tiers[i - 1];
    if (prev && !(count > prev.count))
      errors.push(`주간 누적 ${i + 1}단계: 건수가 앞 단계보다 커야 합니다.`);
    if (prev && !(total > prev.total))
      errors.push(`주간 누적 ${i + 1}단계: 누적 금액이 앞 단계보다 커야 합니다.`);
    tiers.push({ count, total });
  });

  const p = (r.perks && typeof r.perks === "object" ? r.perks : {}) as Record<string, unknown>;
  const perks = {
    friend: int(p.friend),
    welcomeCount: int(p.welcomeCount),
    welcomePay: int(p.welcomePay),
    gearCount: int(p.gearCount),
  };
  if (!isInt(perks.friend, 0, 1_000_000))
    errors.push("친구추천 보상은 0~1,000,000원 사이 정수여야 합니다.");
  if (!isInt(perks.welcomeCount, 1, 3000))
    errors.push("웰컴 미션 건수는 1~3000 사이 정수여야 합니다.");
  if (!isInt(perks.welcomePay, 0, 1_000_000))
    errors.push("웰컴 미션 보상은 0~1,000,000원 사이 정수여야 합니다.");
  if (!isInt(perks.gearCount, 1, 3000)) errors.push("장비지원 건수는 1~3000 사이 정수여야 합니다.");

  const ru = (r.rules && typeof r.rules === "object" ? r.rules : {}) as Record<string, unknown>;
  const rules = { cancelRateMax: int(ru.cancelRateMax), duplicate: ru.duplicate !== false };
  if (!isInt(rules.cancelRateMax, 0, 100))
    errors.push("거절·취소율 기준은 0~100 사이 정수여야 합니다.");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: { schema: MISSION_CONFIG_SCHEMA, ...timed, weekly: { tiers }, perks, rules },
  };
}

// ───────────────────────── 계산·표기 ─────────────────────────

export function missionMax(m: TimedMission): number {
  if (!m.enabled) return 0;
  return m.basis === "daily"
    ? m.groups.reduce((a, g) => a + g.pay * g.days.length, 0)
    : m.groups.reduce((a, g) => a + g.pay, 0);
}

export function weeklyMax(c: MissionConfig): number {
  return c.weekly.tiers.length ? c.weekly.tiers[c.weekly.tiers.length - 1].total : 0;
}

export function totalMax(c: MissionConfig): number {
  return TIMED_KEYS.reduce((a, k) => a + missionMax(c[k]), 0) + weeklyMax(c);
}

/** 8000 → "8,000원" */
export function won(n: number): string {
  return `${n.toLocaleString("en-US")}원`;
}

/** 40000 → "4만원", 52000 → "5만 2천원", 282000 → "28만 2천원", 8000 → "8,000원" */
export function man(n: number): string {
  const m = Math.floor(n / 10000);
  const r = n % 10000;
  if (m === 0) return won(n);
  if (r === 0) return `${m}만원`;
  if (r % 1000 === 0) return `${m}만 ${r / 1000}천원`;
  return `${m}만 ${r.toLocaleString("en-US")}원`;
}

/** 히어로 통계용: 282000 → "28.2만", 120000 → "12만" */
export function manShort(n: number): string {
  const v = Math.round(n / 1000) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}만`;
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** [1..5] → "평일", [0,6] → "주말", 전체 → "매일", 그 외 "월·화" (카드 머리·요약용) */
export function dayLabel(days: number[], sep = "·"): string {
  const key = sortDays(days).join(",");
  if (key === "6,0") return "주말";
  if (key === "1,2,3,4,5") return "평일";
  return dayList(days, sep);
}

/** 요일을 나열: [1..5] → "월~금", 전체 → "매일", 그 외 "토 · 일" (줄·시간표용) */
export function dayList(days: number[], sep = "·"): string {
  const s = sortDays(days);
  const key = s.join(",");
  if (key === "1,2,3,4,5,6,0") return "매일";
  if (key === "1,2,3,4,5") return "월~금";
  return s.map((d) => DAY_NAMES[d]).join(sep);
}

function sortDays(days: number[]): number[] {
  return [...days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
}

/** 미션별 머리 시간 문구 — 기존 페이지 표기(평일런치 "월~금 …", 올빼미 "21:00~23:59")를 유지 */
export function headerTime(c: MissionConfig, k: TimedKey): string {
  const t = timeSummary(c[k]);
  if (k === "lunch") return t.replace(/^평일 /, "월~금 ");
  if (k === "owl") return t.replace(/^매일 /, "");
  return t;
}

/** 카드 머리의 시간 문구: "평일 13:00~16:54 · 주말 14:00~16:54" */
export function timeSummary(m: TimedMission): string {
  const byRange = new Map<string, number[]>();
  for (const g of m.groups) {
    const k = `${g.from}~${g.to}`;
    byRange.set(k, [...(byRange.get(k) ?? []), ...g.days]);
  }
  return [...byRange.entries()].map(([range, days]) => `${dayLabel(days)} ${range}`).join(" · ");
}

// ───────────────────────── HTML 렌더링 ─────────────────────────

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rowsHtml(m: TimedMission): string {
  const out: string[] = [];
  const multi = m.groups.length > 1;
  for (const g of m.groups) {
    if (m.basis === "daily") {
      if (multi) {
        out.push(
          `<div class="grp-label">${esc(dayList(g.days, " · "))} <small style="font-weight:600;color:var(--navy-2)">${esc(g.from)}~${esc(g.to)}</small></div>`,
        );
        out.push(
          `<div class="row"><span class="cond">각각 <b>${g.count}건</b> 이상 완료</span><span class="amt tnum">${won(g.pay)}</span></div>`,
        );
      } else {
        out.push(
          `<div class="row"><span class="cond">매일 <b>${g.count}건</b> 이상 완료</span><span class="amt tnum">${won(g.pay)}</span></div>`,
        );
      }
    } else {
      out.push(
        `<div class="row"><span class="cond">${esc(dayList(g.days, " · "))} 합산 · <b>${g.count}건</b></span><span class="amt tnum">${won(g.pay)}</span></div>`,
      );
    }
  }
  out.push(
    `<div class="grp-label">${m.basis === "daily" ? "매일 개별 집계 · 지급" : "요일 묶음별 해당 시간 합산"}</div>`,
  );
  if (m.note) out.push(`<div class="grp-label">${esc(m.note)}</div>`);
  return out.join("\n        ");
}

function h(t: string): number {
  const [a, b] = t.split(":").map(Number);
  return a + b / 60;
}

export type BoardRow = {
  name: string;
  days: number[];
  from: number;
  to: number;
  d: string;
  tm: string;
  pay: string;
};

export function boardRows(c: MissionConfig): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const k of TIMED_KEYS) {
    const m = c[k];
    if (!m.enabled) continue;
    for (const g of m.groups) {
      const pay =
        m.basis === "sum"
          ? `합산 ${g.count}건 ${g.pay.toLocaleString("en-US")}`
          : `${m.groups.length > 1 ? "각각" : "매일"} ${g.count}건 ${g.pay.toLocaleString("en-US")}`;
      rows.push({
        name: MISSION_TITLES[k].board,
        days: g.days,
        from: h(g.from),
        to: h(g.to),
        d: dayList(g.days),
        tm: `${g.from}~${g.to}`,
        pay,
      });
    }
  }
  return rows;
}

/** HTML 마커 이름 → 채워 넣을 내용 */
export function renderMissionBlocks(c: MissionConfig): Record<string, string> {
  const total = totalMax(c);
  const tiers = c.weekly.tiers;
  const first = tiers[0];
  const last = tiers[tiers.length - 1];
  const n = tiers.length;
  const tierHtml = tiers
    .map((t, i) => {
      const plus = t.total - (i ? tiers[i - 1].total : 0);
      const w = n === 1 ? 100 : Math.round(35 + (65 * i) / (n - 1));
      return `<div class="tier${i === n - 1 ? " max" : ""}" style="--w:${w}%"><span class="fill"></span><span class="cnt tnum">${t.count}건~</span><span class="bar"><i></i></span><span class="plus tnum">+${man(plus)}</span></div>`;
    })
    .join("\n        ");

  const sumRows = TIMED_KEYS.filter((k) => c[k].enabled)
    .map(
      (k) =>
        `<div class="sumr"><span>${MISSION_TITLES[k].sum} (${esc(headerTime(c, k))})</span><b class="tnum">최대 ${man(missionMax(c[k]))}</b></div>`,
    )
    .concat(
      `<div class="sumr"><span>주간 누적 미션 (수~화 완료 건수)</span><b class="tnum">최대 ${man(weeklyMax(c))}</b></div>`,
      `<div class="sumr" style="background:var(--gold-soft)"><span><b>주간 미션 합계</b> <small style="color:var(--mut)">+α: 게릴라 · 웰컴 · 친구추천 · 정비지원 미션</small></span><b class="tnum" style="color:var(--gold-2)">최대 ${man(total)} +α</b></div>`,
    )
    .join("\n      ");

  const chips = [
    `<span class="msb-chip">주간 누적 ${first.count} → ${last.count}건 <b>최대 ${man(last.total)}</b></span>`,
    `<span class="msb-chip">친구추천 <b>${man(c.perks.friend)}</b></span>`,
    `<span class="msb-chip">웰컴 · 등록 후 첫 주 ${c.perks.welcomeCount}건 <b>${man(c.perks.welcomePay)}</b></span>`,
    `<span class="msb-chip">오일 · 패드 · ${c.perks.gearCount}건 이상 <b>무상 지원</b></span>`,
    c.rules.duplicate ? `<span class="msb-chip">미션 간 <b>중복지급</b></span>` : "",
    `<span class="msb-chip">거절 · 취소율 <b>${c.rules.cancelRateMax}% 이하</b></span>`,
  ]
    .filter(Boolean)
    .join("\n          ");

  const lunch = c.lunch;
  const lunchStep = lunch.enabled
    ? `<b>평일런치 미션(${esc(headerTime(c, "lunch"))})</b> ${lunch.groups[0]?.count ?? ""}건 달성부터 시작할 수 있습니다. `
    : "";

  const blocks: Record<string, string> = {
    "og-desc": `<meta property="og:description" content="대전 쿠팡이츠플러스 라이더 모집·현재 미션·정산·지원 절차 안내. 미션 보상 주간 최대 ${esc(man(total))}+α.">`,
    "stat-total": `${manShort(total)}+α`,
    total: man(total),
    "lunch-time": esc(headerTime(c, "lunch")),
    "lunch-rows": rowsHtml(lunch),
    "postlunch-time": esc(headerTime(c, "postlunch")),
    "postlunch-rows": rowsHtml(c.postlunch),
    "owl-time": esc(headerTime(c, "owl")),
    "owl-rows": rowsHtml(c.owl),
    friend: `추천인 보상 <b>${man(c.perks.friend)}</b> 지급`,
    welcome: `신입기사 등록 후 첫 주 ${c.perks.welcomeCount}건 이상 달성 시 <b>${man(c.perks.welcomePay)}</b> 지급`,
    gear: `${c.perks.gearCount}건 이상 완료 시 오일·패드 <b>무상지원</b>`,
    tiers: tierHtml,
    "jackpot-h": `${last.count}건 달성 시<br>주간 총 <b class="tnum">${man(last.total)}</b> 지급!`,
    "jackpot-p": `${c.perks.gearCount}건 이상 오일·패드 무상교환 · ${first.count}건~${last.count}건 구간별 순차 달성 시 누적 지급`,
    sumlist: sumRows,
    chips,
    "faq-step5": `${lunchStep}신입 기사는 <b>웰컴 미션(등록 후 첫 주 ${c.perks.welcomeCount}건 달성 시 ${man(c.perks.welcomePay)})</b>이 있고, ${c.perks.gearCount}건 이상 완료 시 <b>오일·패드 무상지원</b>도 받을 수 있습니다.`,
  };
  return blocks;
}

/** 카드 표시 여부 — 비활성 미션 카드는 통째로 숨긴다 */
export function cardHidden(c: MissionConfig, k: TimedKey): string {
  return c[k].enabled ? "" : " hidden";
}

const MARK_RE = /<!--mc:([a-z0-9-]+)-->([\s\S]*?)<!--\/mc:\1-->/g;
const JS_MARK_RE = /\/\*mc:timetable\*\/[\s\S]*?\/\*\/mc:timetable\*\//;
const HIDE_RE = /data-mc-card="(lunch|postlunch|owl)"(?: hidden)?/g;

/** 문서 안의 `<!--mc:이름-->…<!--/mc:이름-->` 과 시간표 배열을 설정값으로 교체한다. */
export function applyMissionConfig(html: string, c: MissionConfig): string {
  const blocks = renderMissionBlocks(c);
  const board = JSON.stringify(boardRows(c)).replace(/</g, "\\u003c");
  return html
    .replace(MARK_RE, (whole, name: string) =>
      name in blocks ? `<!--mc:${name}-->${blocks[name]}<!--/mc:${name}-->` : whole,
    )
    .replace(JS_MARK_RE, `/*mc:timetable*/${board}/*/mc:timetable*/`)
    .replace(HIDE_RE, (_w, k: TimedKey) => `data-mc-card="${k}"${cardHidden(c, k)}`);
}

// ───────────────────────── 텍스트(챗봇 · llms.txt) ─────────────────────────

/** 챗봇 시스템 프롬프트에 들어갈 미션 지식(한국어) */
export function missionKnowledgeKo(c: MissionConfig): string {
  const parts: string[] = [];
  for (const k of TIMED_KEYS) {
    const m = c[k];
    if (!m.enabled) continue;
    const gs = m.groups
      .map((g) =>
        m.basis === "sum"
          ? `${dayList(g.days)} 합산 ${g.count}건 ${won(g.pay)}`
          : `${dayList(g.days)} ${g.from}~${g.to} ${m.groups.length > 1 ? "각각" : "매일"} ${g.count}건 ${won(g.pay)}`,
      )
      .join(" / ");
    parts.push(
      `${MISSION_TITLES[k].board}(${headerTime(c, k)}, ${gs}, ${m.basis === "daily" ? "매일 개별 지급" : "요일 묶음별 합산"}, 최대 ${man(missionMax(m))}${m.note ? `, ${m.note}` : ""})`,
    );
  }
  const tiers = c.weekly.tiers.map((t) => `${t.count}건 ${man(t.total)}`).join(" → ");
  return [
    `- 미션 보상 주간 최대 ${man(totalMax(c))} +α. 콜비+미션 합산으로 주 150만원 이상 도전 가능(성실 수행 기준, 보장 금액 아님, 건수·시간대에 따라 다름)`,
    `- 미션 종류: ${parts.join(", ")}, 주간 누적(수~화 완료 건수, 단계별 누적 보상: ${tiers})`,
    `- 추가 혜택: 친구추천 ${man(c.perks.friend)}, 웰컴(신규 등록 첫 주 ${c.perks.welcomeCount}건 달성 시 ${man(c.perks.welcomePay)}), 장비지원(${c.perks.gearCount}건 이상 오일·패드 무상), 거절·취소율 ${c.rules.cancelRateMax}% 이하 조건${c.rules.duplicate ? ", 미션 간 중복지급" : ""}, 비정기 게릴라 미션은 앱 공지`,
  ].join("\n");
}

const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** llms.txt 용 영문 요약 */
export function missionSummaryEn(c: MissionConfig): string {
  const lines: string[] = [];
  const names: Record<TimedKey, string> = {
    lunch: "Lunch mission",
    postlunch: "Post-lunch mission",
    owl: "Night owl mission",
  };
  for (const k of TIMED_KEYS) {
    const m = c[k];
    if (!m.enabled) continue;
    lines.push(`${names[k]} (${m.basis === "daily" ? "paid per day" : "combined per day group"}):`);
    for (const g of m.groups) {
      lines.push(
        `- ${g.days.map((d) => EN_DAYS[d]).join("/")} ${g.from}-${g.to}, ${g.count} completed deliveries, KRW ${g.pay.toLocaleString("en-US")}`,
      );
    }
  }
  lines.push(
    `Weekly cumulative mission (Wed-Tue): ${c.weekly.tiers.map((t) => `${t.count} deliveries KRW ${t.total.toLocaleString("en-US")}`).join(", ")} (cumulative)`,
  );
  lines.push(
    `Current fixed-mission weekly maximum: KRW ${totalMax(c).toLocaleString("en-US")} plus optional additional missions`,
  );
  return lines.join("\n");
}
