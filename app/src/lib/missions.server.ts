// 미션 D1 접근 계층. 도메인 규칙은 전부 ./missions 에 있고 여기는 저장소 접근만
// 담당한다. 4-2B 범위는 **조회 기반**이며, 쓰기 헬퍼(감사 로그·낙관적 잠금·
// 쓰기 차단)는 4-2C 가 그대로 쓰도록 여기 정의만 해 둔다. 쓰기 엔드포인트는
// 4-2B 에 없다.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { bindings } from "./bindings.server";
import {
  MISSION_SCHEMA_VERSION,
  evaluateWriteAccess,
  interpretUpdateResult,
  type Mission,
  type MissionDataPayload,
  type MissionStatus,
  type MissionTier,
  type MissionType,
  type WriteAccessResult,
} from "./missions";

export interface MissionRow {
  id: string;
  name: string;
  type: string;
  group_key: string;
  day_mask: number;
  start_min: number | null;
  end_min: number | null;
  end_day_offset: number;
  days_label: string | null;
  note: string | null;
  publish_from: string | null;
  publish_to: string | null;
  active: number;
  sort_order: number;
  status: string;
  version: number;
}

export interface TierRow {
  mission_id: string;
  target_count: number;
  reward_amount: number;
  sort_order: number;
}

export function rowToMission(row: MissionRow, tiers: MissionTier[] = []): Mission {
  return {
    id: row.id,
    name: row.name,
    type: row.type as MissionType,
    groupKey: row.group_key,
    dayMask: row.day_mask,
    startMin: row.start_min,
    endMin: row.end_min,
    endDayOffset: row.end_day_offset === 1 ? 1 : 0,
    daysLabel: row.days_label,
    note: row.note,
    publishFrom: row.publish_from,
    publishTo: row.publish_to,
    active: row.active === 1,
    sortOrder: row.sort_order,
    status: row.status as MissionStatus,
    version: row.version,
    tiers: tiers.slice().sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

export function groupTiers(rows: readonly TierRow[]): Map<string, MissionTier[]> {
  const map = new Map<string, MissionTier[]>();
  for (const r of rows) {
    const list = map.get(r.mission_id) ?? [];
    list.push({ targetCount: r.target_count, rewardAmount: r.reward_amount, sortOrder: r.sort_order });
    map.set(r.mission_id, list);
  }
  return map;
}

export class MissionStoreUnavailable extends Error {
  constructor(public readonly cause_: unknown) {
    super("mission store unavailable");
    this.name = "MissionStoreUnavailable";
  }
}

const PUBLIC_SELECT = `
  SELECT id, name, type, group_key, day_mask, start_min, end_min, end_day_offset,
         days_label, note, publish_from, publish_to, active, sort_order, status, version
    FROM missions
   WHERE status = 'published'
     AND active = 1
     AND (publish_from IS NULL OR publish_from <= ?1)
     AND (publish_to   IS NULL OR publish_to   >= ?1)
   ORDER BY sort_order ASC, id ASC
`;

const TIER_SELECT = `
  SELECT t.mission_id, t.target_count, t.reward_amount, t.sort_order
    FROM mission_tiers t
    JOIN missions m ON m.id = t.mission_id
   WHERE m.status = 'published'
     AND m.active = 1
     AND (m.publish_from IS NULL OR m.publish_from <= ?1)
     AND (m.publish_to   IS NULL OR m.publish_to   >= ?1)
   ORDER BY t.mission_id ASC, t.sort_order ASC
`;

/**
 * 공개 조회. 읽기 전용이므로 read replica 를 허용한다
 * (withSession 기본값 'first-unconstrained' — 지연을 낮추고, 순차 일관성은 유지).
 * 테이블이 아직 없거나 쿼리가 실패하면 MissionStoreUnavailable 을 던져
 * 호출부가 503 으로 바꾸고, 클라이언트는 정적 폴백으로 간다.
 */
export async function listPublishedMissions(db: D1Database, nowIso: string): Promise<Mission[]> {
  try {
    const session = db.withSession("first-unconstrained");
    const [missionRes, tierRes] = await session.batch<Record<string, unknown>>([
      session.prepare(PUBLIC_SELECT).bind(nowIso),
      session.prepare(TIER_SELECT).bind(nowIso),
    ]);
    const tierRows = (tierRes?.results ?? []) as unknown as TierRow[];
    const missionRows = (missionRes?.results ?? []) as unknown as MissionRow[];
    const tiers = groupTiers(tierRows);
    return missionRows.map((r) => rowToMission(r, tiers.get(r.id) ?? []));
  } catch (e) {
    throw new MissionStoreUnavailable(e);
  }
}

export function buildPayload(missions: Mission[], nowIso: string): MissionDataPayload {
  return { ok: true, schema: MISSION_SCHEMA_VERSION, serverNow: nowIso, missions };
}

// ─────────────────────────────────────────────────────────────
// 아래는 4-2C 가 쓸 쓰기 기반. 4-2B 에는 이를 호출하는 엔드포인트가 없다.
// ─────────────────────────────────────────────────────────────

/**
 * 저장 직후 조회 일관성 (승인 조건 9).
 *
 * D1 은 read replica 를 둘 수 있어 쓰기 직후 replica 를 읽으면 예전 값이
 * 나올 수 있다. 관리자 저장 → 미리보기 동선에서는 반드시 이 세션을 쓴다.
 * 'first-primary' 는 세션의 첫 쿼리를 primary 로 보내고, 이후 쿼리는 그
 * 세션 안에서 순차 일관성이 보장된다.
 *
 * 저장과 재조회가 같은 요청 안에서 일어날 때는 세션을 하나로 유지하는 대신
 * **쓰기 응답이 돌려준 값을 그대로 쓰는 편이 더 싸다**(readAfterWrite 참고).
 */
export function primarySession(db: D1Database) {
  return db.withSession("first-primary");
}

/**
 * 쓰기 결과를 그대로 응답에 쓰는 경로. 재조회 자체를 없애 replica 지연 문제를
 * 회피한다. 재조회가 꼭 필요한 경우에만 primarySession 을 쓴다.
 */
export function readAfterWrite<T>(written: T): T {
  return written;
}

export interface AuditEntry {
  id: string;
  missionId: string;
  action: "create" | "update" | "publish" | "end" | "archive" | "restore" | "import";
  actor: string;
  fromVersion: number | null;
  toVersion: number | null;
  before: unknown;
  after: unknown;
}

const AUDIT_INSERT = `
  INSERT INTO mission_audit
    (id, mission_id, action, actor, from_version, to_version, before_json, after_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function buildAuditStatement(db: D1Database, e: AuditEntry, nowIso: string): D1PreparedStatement {
  return db
    .prepare(AUDIT_INSERT)
    .bind(
      e.id,
      e.missionId,
      e.action,
      e.actor,
      e.fromVersion,
      e.toVersion,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      nowIso,
    );
}

/**
 * 감사 로그는 첫 쓰기부터 필수이며 **미션 변경과 같은 트랜잭션**에 들어간다
 * (승인 조건 10). D1 의 batch() 는 하나의 트랜잭션으로 실행되므로, 감사
 * 기록이 실패하면 미션 변경도 함께 롤백된다.
 */
export async function writeWithAudit(
  db: D1Database,
  mutations: readonly D1PreparedStatement[],
  audit: D1PreparedStatement,
): Promise<{ changes: number; result: "updated" | "conflict" }> {
  if (mutations.length === 0) throw new Error("writeWithAudit: 변경 구문이 비어 있습니다.");
  const res = await db.batch([...mutations, audit]);
  const changes = res
    .slice(0, mutations.length)
    .reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  return { changes, result: interpretUpdateResult(changes) };
}

/** 관리자 쓰기 허용 여부. 허용되지 않으면 403 을 만든다 (승인 조건 8). */
export function checkWriteAccess(request: Request): WriteAccessResult {
  const env = bindings();
  return evaluateWriteAccess({
    host: new URL(request.url).host,
    hfEnv: env.HF_ENV ?? null,
  });
}

export function writeForbiddenResponse(access: WriteAccessResult): Response {
  return Response.json(
    { ok: false, error: "write_forbidden", reason: access.reason },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
