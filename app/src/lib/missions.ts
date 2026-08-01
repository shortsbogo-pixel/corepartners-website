// 미션 도메인 로직 — 순수 함수만. 의존성 0(런타임 import 없음).
//
// missions.server.ts 와 일부러 분리했다. 서버 모듈은 `cloudflare:workers` 를
// import 하므로 Workers 런타임 밖에서는 불러올 수 없고, 그러면 요일·자정 경과·
// 검증 같은 핵심 규칙을 단위 테스트할 방법이 없어진다. 규칙은 전부 여기에 두고
// 서버 모듈은 D1 접근만 담당한다.

export const MISSION_SCHEMA_VERSION = 1;

export const MISSION_TYPES = ["regular", "weekly", "adhoc", "night", "notice"] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

export const MISSION_STATUSES = ["draft", "published", "ended", "archived"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** 보드가 한 미션 행에 부여하는 표시 상태. */
export type DisplayState = "live" | "upcoming" | "ended" | "off" | "timeless";

export const MAX_TIERS = 4;
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

/** 미션보드 가로축 (coupang.html 의 START=10, END=24 와 같은 값). */
export const AXIS_START_MIN = 10 * 60;
export const AXIS_END_MIN = 24 * 60;

export interface MissionTier {
  targetCount: number;
  rewardAmount: number;
  sortOrder: number;
}

export interface Mission {
  id: string;
  name: string;
  type: MissionType;
  groupKey: string;
  /** bit0=일 … bit6=토. 0 = 요일 무관. */
  dayMask: number;
  /** 자정 기준 분. null 이면 시간 무관 미션. */
  startMin: number | null;
  endMin: number | null;
  /** 0 = 당일 종료, 1 = 익일 종료(자정 경과). */
  endDayOffset: 0 | 1;
  daysLabel: string | null;
  note: string | null;
  /** UTC ISO8601. */
  publishFrom: string | null;
  publishTo: string | null;
  active: boolean;
  sortOrder: number;
  status: MissionStatus;
  version: number;
  tiers: MissionTier[];
}

/**
 * 미션 데이터의 출처.
 *
 *   dynamic — D1 의 게시 미션을 쓴다. missions 가 빈 배열이면 **정상 빈 상태**다
 *             (전체 비활성·게시 기간 밖도 여기에 해당한다).
 *   static  — 운영자가 ops_settings.mission_source='static' 으로 꺼 둔 상태.
 *             보드는 코드에 남겨 둔 정적 MISSIONS 상수로 렌더한다.
 *             **장애가 아니라 의도된 상태**이므로 fallback 과 구분해 다룬다.
 */
export const MISSION_SOURCES = ["dynamic", "static"] as const;
export type MissionSource = (typeof MISSION_SOURCES)[number];

export const DEFAULT_MISSION_SOURCE: MissionSource = "dynamic";
export const MISSION_SOURCE_KEY = "mission_source";

/** ops_settings 에서 읽은 값을 계약값으로 좁힌다. 알 수 없는 값은 기본값으로. */
export function parseMissionSource(v: unknown): MissionSource {
  const s = String(v ?? "").trim().toLowerCase();
  return (MISSION_SOURCES as readonly string[]).includes(s) ? (s as MissionSource) : DEFAULT_MISSION_SOURCE;
}

/** /mission-data 의 성공 응답 계약. */
export interface MissionDataPayload {
  ok: true;
  schema: number;
  source: MissionSource;
  serverNow: string;
  missions: Mission[];
}

// ─────────────────────────────────────────────────────────────
// 요일 마스크
// ─────────────────────────────────────────────────────────────

export const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;
export const DAY_MASK_ALL = 0b1111111; // 127
export const DAY_MASK_WEEKDAY = 0b0111110; // 62  월~금
export const DAY_MASK_WEEKEND = 0b1000001; // 65  토·일

export function dayMaskFromDays(days: readonly number[]): number {
  let mask = 0;
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new RangeError(`요일 값이 0~6 범위를 벗어났습니다: ${d}`);
    mask |= 1 << d;
  }
  return mask;
}

export function daysFromMask(mask: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 7; d += 1) if (mask & (1 << d)) out.push(d);
  return out;
}

export function hasDay(mask: number, day: number): boolean {
  return (mask & (1 << day)) !== 0;
}

/** days_label 이 비어 있을 때 쓸 자동 라벨. */
export function formatDaysLabel(mask: number): string {
  if (mask === 0) return "상시";
  if (mask === DAY_MASK_ALL) return "매일";
  if (mask === DAY_MASK_WEEKDAY) return "평일";
  if (mask === DAY_MASK_WEEKEND) return "주말";
  return daysFromMask(mask)
    .map((d) => DAY_NAMES[d])
    .join("·");
}

// ─────────────────────────────────────────────────────────────
// 시각 · 자정 경과
// ─────────────────────────────────────────────────────────────

export function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) throw new RangeError(`HH:MM 형식이 아닙니다: ${v}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new RangeError(`시각 범위를 벗어났습니다: ${v}`);
  return h * 60 + mi;
}

/** 시간 무관 미션이면 null. 자정 경과분을 포함한 실제 지속 시간(분). */
export function durationMin(m: Pick<Mission, "startMin" | "endMin" | "endDayOffset">): number | null {
  if (m.startMin === null || m.endMin === null) return null;
  return m.endDayOffset === 1 ? MINUTES_PER_DAY - m.startMin + m.endMin : m.endMin - m.startMin;
}

export interface Occurrence {
  /** 주 기준 분(0 = 일요일 00:00). */
  startWeekMin: number;
  /** startWeekMin + duration. MINUTES_PER_WEEK 를 넘을 수 있다(토요일 밤 → 일요일). */
  endWeekMin: number;
  /** 이 회차가 시작하는 요일. */
  startDay: number;
}

/** 이번 주에 이 미션이 열리는 모든 회차. */
export function occurrences(m: Pick<Mission, "dayMask" | "startMin" | "endMin" | "endDayOffset">): Occurrence[] {
  const dur = durationMin(m);
  if (dur === null || m.startMin === null) return [];
  return daysFromMask(m.dayMask).map((d) => {
    const start = d * MINUTES_PER_DAY + m.startMin!;
    return { startWeekMin: start, endWeekMin: start + dur, startDay: d };
  });
}

/** 주 경계를 넘는 구간(토요일 밤 → 일요일 새벽)을 감안한 포함 판정. */
export function weekRangeContains(x: number, startWeekMin: number, endWeekMin: number): boolean {
  if (endWeekMin <= MINUTES_PER_WEEK) return x >= startWeekMin && x < endWeekMin;
  return x >= startWeekMin || x < endWeekMin - MINUTES_PER_WEEK;
}

export interface ClockNow {
  /** 0=일 … 6=토 */
  day: number;
  /** 자정 기준 분 */
  minutes: number;
}

export function clockFromDate(d: Date): ClockNow {
  return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

function weekMinutes(now: ClockNow): number {
  return now.day * MINUTES_PER_DAY + now.minutes;
}

/**
 * 지금 이 미션을 보드에 어떤 상태로 그릴지.
 *
 * 자정 경과(end_day_offset=1)를 반드시 감안한다. 예를 들어 월요일 21:30~익일
 * 01:30 미션은 화요일 00:30 시점에 여전히 LIVE 이고, 화요일 02:00 에는 (어제
 * 시작한 회차가 오늘 끝났으므로) 'ended' 다.
 */
export function displayState(
  m: Pick<Mission, "dayMask" | "startMin" | "endMin" | "endDayOffset">,
  now: ClockNow,
): DisplayState {
  if (m.startMin === null) return "timeless";

  const occs = occurrences(m);
  if (occs.length === 0) return "off";
  const nowWeek = weekMinutes(now);

  for (const o of occs) {
    if (weekRangeContains(nowWeek, o.startWeekMin, o.endWeekMin)) return "live";
  }

  // 오늘 시작하는 회차
  const todayOcc = occs.find((o) => o.startDay === now.day);
  if (todayOcc) {
    if (nowWeek < todayOcc.startWeekMin) return "upcoming";
    return "ended";
  }

  // 어제 시작해 오늘 끝나는 회차(자정 경과)
  if (m.endDayOffset === 1) {
    const yesterday = (now.day + 6) % 7;
    const carried = occs.find((o) => o.startDay === yesterday);
    if (carried) return "ended";
  }

  return "off";
}

/** 오늘 화면에 그릴 회차(막대 위치 계산용). 없으면 null. */
export function activeOccurrence(
  m: Pick<Mission, "dayMask" | "startMin" | "endMin" | "endDayOffset">,
  now: ClockNow,
): Occurrence | null {
  const occs = occurrences(m);
  if (occs.length === 0) return null;
  const nowWeek = weekMinutes(now);
  for (const o of occs) if (weekRangeContains(nowWeek, o.startWeekMin, o.endWeekMin)) return o;
  return occs.find((o) => o.startDay === now.day) ?? null;
}

export interface AxisSegment {
  /** 0~100 (%) */
  leftPct: number;
  widthPct: number;
  /** 자정을 넘어 다음 날 축으로 이어지는 조각인지. */
  carriedOver: boolean;
}

/**
 * 회차를 10:00~24:00 가로축 위의 조각들로 변환한다.
 *
 * 축을 벗어나는 부분은 잘라낸다. 자정을 넘는 미션은 조각이 둘로 나뉘는데,
 * 두 번째 조각(익일 00:00~end)은 축이 10시에서 시작하므로 대부분 축 밖이며
 * 그 경우 빈 배열이 아니라 첫 조각만 남는다. 라벨 열에 '익일 HH:MM' 를 함께
 * 표기해야 정보가 유실되지 않는다(4-2D 렌더 규칙).
 */
export function axisSegments(m: Pick<Mission, "startMin" | "endMin" | "endDayOffset">): AxisSegment[] {
  if (m.startMin === null || m.endMin === null) return [];
  const span = AXIS_END_MIN - AXIS_START_MIN;
  const pct = (min: number) => ((min - AXIS_START_MIN) / span) * 100;
  const clip = (from: number, to: number, carriedOver: boolean): AxisSegment | null => {
    const a = Math.max(from, AXIS_START_MIN);
    const b = Math.min(to, AXIS_END_MIN);
    if (b <= a) return null;
    return { leftPct: pct(a), widthPct: pct(b) - pct(a), carriedOver };
  };

  const out: AxisSegment[] = [];
  if (m.endDayOffset === 0) {
    const s = clip(m.startMin, m.endMin, false);
    if (s) out.push(s);
    return out;
  }
  const first = clip(m.startMin, MINUTES_PER_DAY, false);
  if (first) out.push(first);
  const second = clip(0, m.endMin, true);
  if (second) out.push(second);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 문자열 안전 처리
// ─────────────────────────────────────────────────────────────

/** 제어문자 제거 + 공백 정규화. 저장 직전에 통과시킨다. */
export function sanitizeText(v: unknown, maxLength: number): string {
  return String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * 관리자 입력은 innerHTML 에 넣지 않는다(승인 조건 12).
 * 렌더는 textContent 를 쓰고, 문자열 조립이 불가피한 자리에서만 이 함수를 쓴다.
 */
export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─────────────────────────────────────────────────────────────
// 검증
// ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export type MissionInput = Omit<Mission, "version" | "status"> & {
  version?: number;
  status?: MissionStatus;
};

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** 두 미션의 회차가 요일·시간대에서 겹치는지 (중복 경고용). */
export function overlaps(
  a: Pick<Mission, "dayMask" | "startMin" | "endMin" | "endDayOffset">,
  b: Pick<Mission, "dayMask" | "startMin" | "endMin" | "endDayOffset">,
): boolean {
  const oa = occurrences(a);
  const ob = occurrences(b);
  if (oa.length === 0 || ob.length === 0) return false;
  for (const x of oa) {
    for (const y of ob) {
      // 주 경계를 넘는 구간까지 비교하려면 한 주를 앞뒤로 펼쳐 본다.
      for (const shift of [-MINUTES_PER_WEEK, 0, MINUTES_PER_WEEK]) {
        const ys = y.startWeekMin + shift;
        const ye = y.endWeekMin + shift;
        if (x.startWeekMin < ye && ys < x.endWeekMin) return true;
      }
    }
  }
  return false;
}

/**
 * 저장 전 검증. error 가 하나라도 있으면 저장하지 않는다.
 * warning 은 관리자에게 보여주되 저장은 허용한다(요구사항 8의 "중복 경고").
 */
export function validateMission(input: MissionInput, others: readonly Mission[] = []): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (field: string, code: string, message: string) =>
    out.push({ field, code, message, severity: "error" });
  const warn = (field: string, code: string, message: string) =>
    out.push({ field, code, message, severity: "warning" });

  const name = sanitizeText(input.name, 40);
  if (name.length === 0) err("name", "name.required", "미션명을 입력해 주세요.");
  if (String(input.name ?? "").length > 40) err("name", "name.tooLong", "미션명은 40자 이내여야 합니다.");

  if (!MISSION_TYPES.includes(input.type)) err("type", "type.invalid", "미션 유형이 올바르지 않습니다.");
  if (sanitizeText(input.groupKey, 60).length === 0)
    err("groupKey", "groupKey.required", "묶음 키가 비어 있습니다.");

  if (!isInt(input.dayMask) || input.dayMask < 0 || input.dayMask > DAY_MASK_ALL)
    err("dayMask", "dayMask.range", "적용 요일 값이 올바르지 않습니다.");

  const hasStart = input.startMin !== null && input.startMin !== undefined;
  const hasEnd = input.endMin !== null && input.endMin !== undefined;
  if (hasStart !== hasEnd)
    err("startMin", "time.pair", "시작 시각과 종료 시각은 함께 입력하거나 함께 비워야 합니다.");

  if (hasStart && hasEnd) {
    const s = input.startMin as number;
    const e = input.endMin as number;
    if (!isInt(s) || s < 0 || s > 1439) err("startMin", "startMin.range", "시작 시각이 범위를 벗어났습니다.");
    if (!isInt(e) || e < 0 || e > 1439) err("endMin", "endMin.range", "종료 시각이 범위를 벗어났습니다.");
    if (input.endDayOffset !== 0 && input.endDayOffset !== 1)
      err("endDayOffset", "endDayOffset.invalid", "익일 종료 값은 0 또는 1이어야 합니다.");
    else if (input.endDayOffset === 0 && isInt(s) && isInt(e) && e <= s)
      err("endMin", "time.order", "종료 시각이 시작 시각보다 빠르거나 같습니다. 자정을 넘는 미션이면 '익일 종료'를 켜 주세요.");
    else if (input.endDayOffset === 1 && isInt(s) && isInt(e) && e >= s)
      err("endMin", "time.crossOrder", "익일 종료 미션은 종료 시각이 시작 시각보다 앞서야 합니다.");
    if (isInt(input.dayMask) && input.dayMask === 0)
      err("dayMask", "dayMask.required", "시간이 지정된 미션은 적용 요일을 하나 이상 선택해야 합니다.");
  } else if (input.endDayOffset === 1) {
    err("endDayOffset", "endDayOffset.needsTime", "시간이 없는 미션에는 익일 종료를 설정할 수 없습니다.");
  }

  // 보상 티어
  const tiers = Array.isArray(input.tiers) ? input.tiers : [];
  if (tiers.length > MAX_TIERS) err("tiers", "tiers.tooMany", `보상 단계는 최대 ${MAX_TIERS}단까지입니다.`);
  if (tiers.length === 0 && input.type !== "notice")
    err("tiers", "tiers.required", "보상 단계를 최소 1단 입력해 주세요. (공지형 미션만 0단이 허용됩니다)");
  const seenCount = new Set<number>();
  const seenSlot = new Set<number>();
  tiers.forEach((t, i) => {
    if (!isInt(t.targetCount) || t.targetCount <= 0)
      err(`tiers[${i}].targetCount`, "tier.count", "목표 건수는 1 이상의 정수여야 합니다.");
    if (!isInt(t.rewardAmount) || t.rewardAmount < 0)
      err(`tiers[${i}].rewardAmount`, "tier.reward", "보상 금액은 0 이상의 정수여야 합니다.");
    if (!isInt(t.sortOrder) || t.sortOrder < 0 || t.sortOrder >= MAX_TIERS)
      err(`tiers[${i}].sortOrder`, "tier.slot", "보상 단계 순서가 올바르지 않습니다.");
    if (seenCount.has(t.targetCount))
      err(`tiers[${i}].targetCount`, "tier.duplicateCount", "같은 목표 건수를 두 번 넣을 수 없습니다.");
    if (seenSlot.has(t.sortOrder))
      err(`tiers[${i}].sortOrder`, "tier.duplicateSlot", "보상 단계 순서가 중복됩니다.");
    seenCount.add(t.targetCount);
    seenSlot.add(t.sortOrder);
  });

  // 게시 기간
  const from = input.publishFrom;
  const to = input.publishTo;
  for (const [field, v] of [["publishFrom", from], ["publishTo", to]] as const) {
    if (v !== null && v !== undefined && Number.isNaN(Date.parse(v)))
      err(field, "publish.format", "게시 일시 형식이 올바르지 않습니다.");
  }
  if (from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to)) && Date.parse(to) < Date.parse(from))
    err("publishTo", "publish.order", "게시 종료일이 게시 시작일보다 빠릅니다.");

  if (!isInt(input.sortOrder) || input.sortOrder < 0)
    err("sortOrder", "sortOrder.range", "정렬 순서는 0 이상의 정수여야 합니다.");

  if (String(input.note ?? "").length > 200)
    err("note", "note.tooLong", "안내 문구는 200자 이내여야 합니다.");
  if (/[<>]/.test(String(input.note ?? "")))
    warn("note", "note.markup", "안내 문구에 < 또는 > 가 있습니다. 화면에는 글자 그대로 표시됩니다.");

  // 다른 미션과의 충돌
  for (const o of others) {
    if (o.id === input.id) continue;
    if (o.status === "archived") continue;
    const sameVariant =
      o.groupKey === input.groupKey &&
      o.dayMask === input.dayMask &&
      o.startMin === (input.startMin ?? null) &&
      o.endMin === (input.endMin ?? null) &&
      o.endDayOffset === input.endDayOffset;
    if (sameVariant) {
      err("groupKey", "variant.duplicate", `같은 조건의 미션이 이미 있습니다 (${o.name}).`);
      continue;
    }
    if (hasStart && hasEnd && (o.dayMask & input.dayMask) !== 0 && overlaps(o, input as Mission))
      warn("startMin", "time.overlap", `같은 요일·시간대에 다른 미션이 있습니다 (${o.name}).`);
  }

  return out;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

// ─────────────────────────────────────────────────────────────
// 정적 폴백 계약
// ─────────────────────────────────────────────────────────────

export type FallbackReason = "network" | "server" | "schema";

export type MissionFetchOutcome =
  | { kind: "data"; payload: MissionDataPayload }
  | { kind: "empty"; payload: MissionDataPayload }
  | { kind: "static"; payload: MissionDataPayload }
  | { kind: "fallback"; reason: FallbackReason };

function isValidTier(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return isInt(t.targetCount) && isInt(t.rewardAmount) && isInt(t.sortOrder);
}

/** 응답 본문이 계약을 만족하는지. 만족하지 않으면 schema 폴백으로 간다. */
export function isMissionDataPayload(v: unknown): v is MissionDataPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (p.ok !== true) return false;
  if (p.schema !== MISSION_SCHEMA_VERSION) return false;
  if (!(MISSION_SOURCES as readonly unknown[]).includes(p.source)) return false;
  if (typeof p.serverNow !== "string" || Number.isNaN(Date.parse(p.serverNow))) return false;
  if (!Array.isArray(p.missions)) return false;
  return p.missions.every((m) => {
    if (typeof m !== "object" || m === null) return false;
    const x = m as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.name !== "string") return false;
    if (!MISSION_TYPES.includes(x.type as MissionType)) return false;
    if (!isInt(x.dayMask)) return false;
    if (x.startMin !== null && !isInt(x.startMin)) return false;
    if (x.endMin !== null && !isInt(x.endMin)) return false;
    if (x.endDayOffset !== 0 && x.endDayOffset !== 1) return false;
    if (!Array.isArray(x.tiers) || !x.tiers.every(isValidTier)) return false;
    return true;
  });
}

/**
 * 정적 폴백 계약 (승인 조건 5·6, 4-2B1 로 갱신).
 *
 *   source='static'          → 'static'    운영자가 의도적으로 끈 상태.
 *                                          보드는 정적 상수로 렌더하되
 *                                          **장애가 아니므로 오류로 보고하지 않는다.**
 *   source='dynamic' + 0건   → 'empty'     정상 빈 상태. 전체 비활성도 여기다.
 *                                          **정적 상수로 되돌아가지 않는다.**
 *   source='dynamic' + N건   → 'data'
 *   네트워크 실패            → 'fallback' reason='network'
 *   5xx                      → 'fallback' reason='server'
 *   계약 불일치              → 'fallback' reason='schema'
 *
 * 4xx(404 포함)는 본문이 계약을 만족하지 않으므로 자연히 schema 로 떨어진다.
 * 별도 분기를 두지 않는 이유는 "네트워크·5xx·스키마만 폴백" 규칙을 문자 그대로
 * 지키기 위해서다.
 */
export function classifyMissionResponse(input: {
  networkError?: boolean;
  status?: number;
  body?: unknown;
}): MissionFetchOutcome {
  if (input.networkError) return { kind: "fallback", reason: "network" };
  const status = input.status ?? 0;
  if (status >= 500) return { kind: "fallback", reason: "server" };
  if (!isMissionDataPayload(input.body)) return { kind: "fallback", reason: "schema" };
  const payload = input.body;
  if (payload.source === "static") return { kind: "static", payload };
  return payload.missions.length === 0 ? { kind: "empty", payload } : { kind: "data", payload };
}

/** 보드가 코드 내 정적 MISSIONS 상수를 써야 하는 경우인가. */
export function usesStaticConstants(outcome: MissionFetchOutcome): boolean {
  return outcome.kind === "static" || outcome.kind === "fallback";
}

/** 장애로 정적 상수를 쓰게 된 경우인가(= 로그·알림 대상). */
export function isDegraded(outcome: MissionFetchOutcome): boolean {
  return outcome.kind === "fallback";
}

// ─────────────────────────────────────────────────────────────
// /mission-data 응답 결정 (서버 계약)
// ─────────────────────────────────────────────────────────────

export type MissionDataResult =
  | { status: 200; body: MissionDataPayload }
  | { status: 503; body: { ok: false; error: string } };

/**
 * 라우트 핸들러가 그대로 쓰는 순수 결정 함수. D1 접근과 분리해 두어야
 * "무엇을 200 으로, 무엇을 503 으로 돌려주는가"를 테스트할 수 있다.
 *
 * **503 은 D1 바인딩 부재와 쿼리 장애뿐이다** (승인 조건 5).
 * 전체 비활성·게시 기간 밖·미션 0건은 전부 200 + dynamic + [] 이다.
 */
export function buildMissionData(
  input:
    | { kind: "no_db" }
    | { kind: "query_failed" }
    | { kind: "static"; serverNow: string }
    | { kind: "dynamic"; serverNow: string; missions: Mission[] },
): MissionDataResult {
  switch (input.kind) {
    case "no_db":
      return { status: 503, body: { ok: false, error: "db_unavailable" } };
    case "query_failed":
      return { status: 503, body: { ok: false, error: "query_failed" } };
    case "static":
      return {
        status: 200,
        body: {
          ok: true,
          schema: MISSION_SCHEMA_VERSION,
          source: "static",
          serverNow: input.serverNow,
          missions: [],
        },
      };
    case "dynamic":
      return {
        status: 200,
        body: {
          ok: true,
          schema: MISSION_SCHEMA_VERSION,
          source: "dynamic",
          serverNow: input.serverNow,
          missions: input.missions,
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────
// 쓰기 허용 환경 판정 (승인 조건 8)
// ─────────────────────────────────────────────────────────────

/**
 * 관리자 쓰기 허용 판정 — **fail-closed** (승인 조건 9·10).
 *
 * 두 값이 **모두 명시돼 있어야만** 허용한다. 하나라도 없으면 거부다.
 *   ADMIN_WRITES_ENABLED  '1' | 'true' 일 때만 켜진다. 그 밖의 값·미설정은 전부 거부.
 *   ADMIN_ALLOWED_HOSTS   쉼표로 구분한 호스트 목록. 비어 있으면 거부.
 *
 * 코드에 운영 호스트를 박아 두지 않는 이유는, 박아 두면 그 상수 자체가 두 번째
 * 진실 공급원이 되어 프리뷰가 우연히 같은 호스트를 갖는 순간 열리기 때문이다.
 * 운영 배포에만 두 값을 넣으면 프리뷰는 **아무것도 설정하지 않는 것만으로** 닫힌다.
 *
 * HF_ENV 는 **추가 거부 조건으로만** 쓴다(조건 10). 값이 비어 있어도 허용을
 * 만들지 못하고, 비운영 값이면 위 두 관문을 통과했더라도 거부한다.
 */
export const NON_PRODUCTION_ENVS = ["dev", "development", "preview", "staging", "test", "local"] as const;

export type WriteDenyReason =
  | "writes_disabled"
  | "allowed_hosts_unset"
  | "missing_host"
  | "host_not_allowed"
  | "non_production_env";

export interface WriteAccessResult {
  allowed: boolean;
  reason: "ok" | WriteDenyReason;
}

export function parseAllowedHosts(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().split(":")[0])
    .filter((h) => h.length > 0);
}

function isTruthyFlag(raw: string | null | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function evaluateWriteAccess(input: {
  host?: string | null;
  hfEnv?: string | null;
  writesEnabled?: string | null;
  allowedHosts?: string | null;
}): WriteAccessResult {
  if (!isTruthyFlag(input.writesEnabled)) return { allowed: false, reason: "writes_disabled" };

  const allowList = parseAllowedHosts(input.allowedHosts);
  if (allowList.length === 0) return { allowed: false, reason: "allowed_hosts_unset" };

  const host = (input.host ?? "").toLowerCase().split(":")[0];
  if (!host) return { allowed: false, reason: "missing_host" };
  if (!allowList.includes(host)) return { allowed: false, reason: "host_not_allowed" };

  const env = (input.hfEnv ?? "").toLowerCase();
  if (env && (NON_PRODUCTION_ENVS as readonly string[]).includes(env))
    return { allowed: false, reason: "non_production_env" };

  return { allowed: true, reason: "ok" };
}

// ─────────────────────────────────────────────────────────────
// 낙관적 잠금
// ─────────────────────────────────────────────────────────────

/**
 * UPDATE missions SET … , version = version + 1 WHERE id = ? AND version = ?
 * 의 결과 해석. changes 가 0 이면 다른 관리자가 먼저 저장한 것이다.
 */
export function interpretUpdateResult(changes: number): "updated" | "conflict" {
  return changes > 0 ? "updated" : "conflict";
}

/** 게시 대상 판정 — /mission-data 의 SQL 필터와 같은 규칙을 코드로 표현한 것. */
export function isPubliclyVisible(m: Mission, nowIso: string): boolean {
  if (!m.active) return false;
  if (m.status !== "published") return false;
  const now = Date.parse(nowIso);
  if (m.publishFrom && Date.parse(m.publishFrom) > now) return false;
  if (m.publishTo && Date.parse(m.publishTo) < now) return false;
  return true;
}
