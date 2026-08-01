// 4-2B 단위 테스트 — 순수 도메인 로직.
// 실행: node --experimental-strip-types --test app/tests/missions.test.ts
// (컨테이너에 node_modules 가 없어 bun/vitest 를 못 쓴다. 의존성 0 로 돌아가도록
//  node 내장 test 러너만 쓴다.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AXIS_END_MIN,
  AXIS_START_MIN,
  DAY_MASK_ALL,
  DAY_MASK_WEEKDAY,
  DAY_MASK_WEEKEND,
  DEFAULT_MISSION_SOURCE,
  MISSION_SCHEMA_VERSION,
  axisSegments,
  buildMissionData,
  classifyMissionResponse,
  clockFromDate,
  dayMaskFromDays,
  daysFromMask,
  displayState,
  durationMin,
  escapeHtml,
  evaluateWriteAccess,
  formatDaysLabel,
  hasErrors,
  hhmmToMinutes,
  interpretUpdateResult,
  isDegraded,
  isMissionDataPayload,
  isPubliclyVisible,
  parseAllowedHosts,
  parseMissionSource,
  minutesToHHMM,
  overlaps,
  sanitizeText,
  usesStaticConstants,
  validateMission,
  type Mission,
  type MissionInput,
} from "../src/lib/missions.ts";

// ── 픽스처 ──────────────────────────────────────────────────
const base: Mission = {
  id: "m1",
  name: "평일런치",
  type: "regular",
  groupKey: "lunch",
  dayMask: DAY_MASK_WEEKDAY,
  startMin: 655, // 10:55
  endMin: 779, // 12:59
  endDayOffset: 0,
  daysLabel: null,
  note: null,
  publishFrom: null,
  publishTo: null,
  active: true,
  sortOrder: 0,
  status: "published",
  version: 1,
  tiers: [
    { targetCount: 10, rewardAmount: 7000, sortOrder: 0 },
    { targetCount: 13, rewardAmount: 10000, sortOrder: 1 },
  ],
};

const mk = (over: Partial<Mission>): Mission => ({ ...base, ...over });

/** 월요일 21:30 → 익일 01:30 (자정 경과) */
const crossMidnight = mk({
  id: "m2",
  name: "야간 올빼미",
  groupKey: "night",
  type: "night",
  dayMask: dayMaskFromDays([1]),
  startMin: 21 * 60 + 30,
  endMin: 1 * 60 + 30,
  endDayOffset: 1,
});

/** 토요일 23:00 → 일요일 02:00 (주 경계까지 넘음) */
const crossWeek = mk({
  id: "m3",
  name: "주말 심야",
  groupKey: "weekend-night",
  type: "night",
  dayMask: dayMaskFromDays([6]),
  startMin: 23 * 60,
  endMin: 2 * 60,
  endDayOffset: 1,
});

/** 시간 무관 미션(주간 누적 · 칩) */
const timeless = mk({
  id: "m4",
  name: "주간 누적",
  groupKey: "weekly",
  type: "weekly",
  dayMask: 0,
  startMin: null,
  endMin: null,
  endDayOffset: 0,
  tiers: [{ targetCount: 180, rewardAmount: 10000, sortOrder: 0 }],
});

const at = (day: number, hhmm: string) => ({ day, minutes: hhmmToMinutes(hhmm) });

// ── 요일 마스크 ─────────────────────────────────────────────
describe("요일 마스크", () => {
  it("월~금은 62, 토·일은 65, 매일은 127", () => {
    assert.equal(dayMaskFromDays([1, 2, 3, 4, 5]), DAY_MASK_WEEKDAY);
    assert.equal(DAY_MASK_WEEKDAY, 62);
    assert.equal(dayMaskFromDays([0, 6]), DAY_MASK_WEEKEND);
    assert.equal(DAY_MASK_WEEKEND, 65);
    assert.equal(dayMaskFromDays([0, 1, 2, 3, 4, 5, 6]), DAY_MASK_ALL);
  });

  it("마스크 ↔ 요일 배열 왕복", () => {
    for (const days of [[1], [0, 6], [1, 2, 3, 4, 5], [3, 4, 5], []]) {
      assert.deepEqual(daysFromMask(dayMaskFromDays(days)), days);
    }
  });

  it("범위를 벗어난 요일은 거부", () => {
    assert.throws(() => dayMaskFromDays([7]), RangeError);
    assert.throws(() => dayMaskFromDays([-1]), RangeError);
  });

  it("자동 라벨", () => {
    assert.equal(formatDaysLabel(0), "상시");
    assert.equal(formatDaysLabel(DAY_MASK_WEEKDAY), "평일");
    assert.equal(formatDaysLabel(DAY_MASK_WEEKEND), "주말");
    assert.equal(formatDaysLabel(DAY_MASK_ALL), "매일");
    assert.equal(formatDaysLabel(dayMaskFromDays([1, 2])), "월·화");
  });
});

// ── 시각 변환 ───────────────────────────────────────────────
describe("시각 변환", () => {
  it("HH:MM ↔ 분 왕복", () => {
    for (const v of ["00:00", "10:55", "12:59", "21:30", "23:59"]) {
      assert.equal(minutesToHHMM(hhmmToMinutes(v)), v);
    }
  });
  it("잘못된 형식 거부", () => {
    for (const v of ["24:00", "10:60", "1055", "", "ab:cd"]) {
      assert.throws(() => hhmmToMinutes(v), RangeError, `허용되면 안 됨: ${v}`);
    }
  });
});

// ── 자정 경과 ───────────────────────────────────────────────
describe("자정 경과 미션", () => {
  it("지속 시간이 자정을 넘겨 계산된다", () => {
    assert.equal(durationMin(base), 124); // 10:55~12:59
    assert.equal(durationMin(crossMidnight), 240); // 21:30~01:30 = 4시간
    assert.equal(durationMin(crossWeek), 180); // 23:00~02:00 = 3시간
    assert.equal(durationMin(timeless), null);
  });

  it("월 21:30~익일 01:30 — 시각별 상태", () => {
    assert.equal(displayState(crossMidnight, at(1, "20:00")), "upcoming"); // 월 시작 전
    assert.equal(displayState(crossMidnight, at(1, "21:30")), "live"); // 월 시작 순간
    assert.equal(displayState(crossMidnight, at(1, "23:59")), "live"); // 월 자정 직전
    assert.equal(displayState(crossMidnight, at(2, "00:00")), "live"); // 화 자정 — 넘어감
    assert.equal(displayState(crossMidnight, at(2, "01:29")), "live"); // 화 종료 직전
    assert.equal(displayState(crossMidnight, at(2, "01:30")), "ended"); // 화 종료 순간
    assert.equal(displayState(crossMidnight, at(2, "09:00")), "ended"); // 화 종료 후
    assert.equal(displayState(crossMidnight, at(3, "00:30")), "off"); // 수 — 무관
  });

  it("토 23:00~일 02:00 — 주 경계를 넘어도 LIVE", () => {
    assert.equal(displayState(crossWeek, at(6, "22:59")), "upcoming");
    assert.equal(displayState(crossWeek, at(6, "23:30")), "live");
    assert.equal(displayState(crossWeek, at(0, "00:10")), "live"); // 일요일 새벽
    assert.equal(displayState(crossWeek, at(0, "01:59")), "live");
    assert.equal(displayState(crossWeek, at(0, "02:00")), "ended");
    assert.equal(displayState(crossWeek, at(0, "12:00")), "ended");
    assert.equal(displayState(crossWeek, at(3, "12:00")), "off");
  });

  it("당일 종료 미션의 기본 상태", () => {
    assert.equal(displayState(base, at(1, "09:00")), "upcoming");
    assert.equal(displayState(base, at(1, "11:00")), "live");
    assert.equal(displayState(base, at(1, "13:00")), "ended");
    assert.equal(displayState(base, at(0, "11:00")), "off"); // 일요일
  });

  it("시간 무관 미션은 timeless", () => {
    assert.equal(displayState(timeless, at(1, "11:00")), "timeless");
  });

  it("clockFromDate 는 로컬 요일·분을 그대로 쓴다", () => {
    const d = new Date(2026, 7, 3, 21, 30); // 2026-08-03 월 21:30 (로컬)
    assert.deepEqual(clockFromDate(d), { day: 1, minutes: 1290 });
  });
});

// ── 축 조각 ─────────────────────────────────────────────────
describe("가로축 조각", () => {
  it("당일 미션은 조각 1개", () => {
    const segs = axisSegments(base);
    assert.equal(segs.length, 1);
    const span = AXIS_END_MIN - AXIS_START_MIN;
    assert.ok(Math.abs(segs[0].leftPct - ((655 - AXIS_START_MIN) / span) * 100) < 1e-9);
    assert.equal(segs[0].carriedOver, false);
  });

  it("자정 경과 미션은 축 안쪽 조각만 남고 익일분은 축 밖이라 잘린다", () => {
    const segs = axisSegments(crossMidnight); // 21:30~24:00 + 00:00~01:30
    assert.equal(segs.length, 1, "익일 00:00~01:30 은 축(10~24시) 밖");
    assert.equal(segs[0].carriedOver, false);
    assert.ok(segs[0].leftPct > 80);
    assert.ok(Math.abs(segs[0].leftPct + segs[0].widthPct - 100) < 1e-9, "24:00 에서 끝나야 한다");
  });

  it("축을 벗어난 미션은 빈 배열", () => {
    assert.deepEqual(axisSegments({ startMin: 60, endMin: 300, endDayOffset: 0 }), []);
  });

  it("시간 무관 미션은 빈 배열", () => {
    assert.deepEqual(axisSegments(timeless), []);
  });
});

// ── 검증 ────────────────────────────────────────────────────
describe("검증 — 안전장치", () => {
  const input = (over: Partial<MissionInput> = {}): MissionInput => ({ ...base, ...over });

  it("정상 입력은 오류 없음", () => {
    assert.equal(hasErrors(validateMission(input())), false);
  });

  it("종료가 시작보다 빠르면 차단", () => {
    const issues = validateMission(input({ startMin: 800, endMin: 700, endDayOffset: 0 }));
    assert.ok(issues.some((i) => i.code === "time.order" && i.severity === "error"));
  });

  it("종료 == 시작도 차단", () => {
    assert.ok(validateMission(input({ startMin: 700, endMin: 700 })).some((i) => i.code === "time.order"));
  });

  it("익일 종료인데 종료가 시작보다 뒤면 차단", () => {
    const issues = validateMission(input({ startMin: 600, endMin: 800, endDayOffset: 1 }));
    assert.ok(issues.some((i) => i.code === "time.crossOrder"));
  });

  it("시간 없는 미션에 익일 종료를 걸면 차단", () => {
    const issues = validateMission(input({ startMin: null, endMin: null, endDayOffset: 1, dayMask: 0 }));
    assert.ok(issues.some((i) => i.code === "endDayOffset.needsTime"));
  });

  it("음수 금액·건수 차단", () => {
    const issues = validateMission(
      input({ tiers: [{ targetCount: -1, rewardAmount: -100, sortOrder: 0 }] }),
    );
    assert.ok(issues.some((i) => i.code === "tier.count"));
    assert.ok(issues.some((i) => i.code === "tier.reward"));
  });

  it("보상 5단은 차단, 4단은 통과", () => {
    const four = [0, 1, 2, 3].map((i) => ({ targetCount: 10 + i, rewardAmount: 1000 * (i + 1), sortOrder: i }));
    assert.equal(hasErrors(validateMission(input({ tiers: four }))), false);
    const five = [...four, { targetCount: 99, rewardAmount: 5000, sortOrder: 4 }];
    assert.ok(validateMission(input({ tiers: five })).some((i) => i.code === "tiers.tooMany"));
  });

  it("공지형만 0단을 허용한다", () => {
    assert.ok(validateMission(input({ tiers: [] })).some((i) => i.code === "tiers.required"));
    assert.equal(hasErrors(validateMission(input({ type: "notice", tiers: [] }))), false);
  });

  it("같은 목표 건수 중복 차단", () => {
    const issues = validateMission(
      input({
        tiers: [
          { targetCount: 10, rewardAmount: 1000, sortOrder: 0 },
          { targetCount: 10, rewardAmount: 2000, sortOrder: 1 },
        ],
      }),
    );
    assert.ok(issues.some((i) => i.code === "tier.duplicateCount"));
  });

  it("게시 종료일이 시작일보다 빠르면 차단", () => {
    const issues = validateMission(
      input({ publishFrom: "2026-08-10T00:00:00Z", publishTo: "2026-08-01T00:00:00Z" }),
    );
    assert.ok(issues.some((i) => i.code === "publish.order"));
  });

  it("시간 지정 미션에 요일이 없으면 차단", () => {
    assert.ok(validateMission(input({ dayMask: 0 })).some((i) => i.code === "dayMask.required"));
  });

  it("완전히 같은 변형은 오류, 겹치기만 하면 경고", () => {
    const dup = validateMission(input({ id: "new" }), [base]);
    assert.ok(dup.some((i) => i.code === "variant.duplicate" && i.severity === "error"));

    const overlap = validateMission(input({ id: "new", groupKey: "other", startMin: 700, endMin: 900 }), [base]);
    const w = overlap.find((i) => i.code === "time.overlap");
    assert.ok(w, "겹침 경고가 있어야 한다");
    assert.equal(w!.severity, "warning");
    assert.equal(hasErrors(overlap), false, "겹침만으로는 저장을 막지 않는다");
  });

  it("자기 자신과는 중복 판정하지 않는다", () => {
    assert.equal(hasErrors(validateMission(input(), [base])), false);
  });

  it("겹침 판정이 자정·주 경계를 넘어서도 동작한다", () => {
    const sunEarly = mk({
      id: "x",
      groupKey: "sun",
      dayMask: dayMaskFromDays([0]),
      startMin: 60,
      endMin: 180,
      endDayOffset: 0,
    });
    assert.equal(overlaps(crossWeek, sunEarly), true, "토 23:00~일 02:00 과 일 01:00~03:00 은 겹친다");
    const monMorning = mk({ id: "y", dayMask: dayMaskFromDays([1]), startMin: 540, endMin: 600 });
    assert.equal(overlaps(crossWeek, monMorning), false);
  });
});

describe("문자열 안전 처리", () => {
  it("제어문자 제거·공백 정규화·길이 제한", () => {
    assert.equal(sanitizeText("  a\u0000b\n\nc  ", 100), "ab c");
    assert.equal(sanitizeText("가".repeat(300), 200).length, 200);
    assert.equal(sanitizeText(null, 10), "");
  });
  it("escapeHtml 이 태그를 무력화한다", () => {
    assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
  it("안내 문구의 꺾쇠는 경고이되 저장은 허용", () => {
    const issues = validateMission({ ...base, note: "10건<20건" });
    assert.ok(issues.some((i) => i.code === "note.markup" && i.severity === "warning"));
    assert.equal(hasErrors(issues), false);
  });
});

// ── 정적 폴백 계약 ──────────────────────────────────────────
describe("정적 폴백 계약", () => {
  const okBody = (missions: Mission[], source = "dynamic") => ({
    ok: true,
    schema: MISSION_SCHEMA_VERSION,
    source,
    serverNow: "2026-08-03T12:00:00.000Z",
    missions,
  });

  it("성공 + 빈 배열은 '정상 빈 상태'이지 폴백이 아니다", () => {
    const r = classifyMissionResponse({ status: 200, body: okBody([]) });
    assert.equal(r.kind, "empty");
  });

  it("성공 + 데이터는 data", () => {
    const r = classifyMissionResponse({ status: 200, body: okBody([base]) });
    assert.equal(r.kind, "data");
  });

  it("네트워크 실패는 network 폴백", () => {
    assert.deepEqual(classifyMissionResponse({ networkError: true }), { kind: "fallback", reason: "network" });
  });

  it("5xx 는 server 폴백", () => {
    for (const s of [500, 502, 503, 504]) {
      assert.deepEqual(classifyMissionResponse({ status: s, body: { ok: false } }), {
        kind: "fallback",
        reason: "server",
      });
    }
  });

  it("계약 불일치는 schema 폴백", () => {
    const bad: unknown[] = [
      null,
      "not json",
      { ok: false },
      { ...okBody([]), schema: 999 },
      { ...okBody([]), serverNow: "언젠가" },
      { ...okBody([]), missions: "nope" },
      (() => { const b: Record<string, unknown> = { ...okBody([]) }; delete b.source; return b; })(),
      { ...okBody([]), source: "bogus" },
      { ...okBody([]), source: null },
      { ...okBody([]), missions: [{ ...base, endDayOffset: 2 }] },
      { ...okBody([]), missions: [{ ...base, type: "unknown" }] },
      { ...okBody([]), missions: [{ ...base, tiers: [{ targetCount: "10" }] }] },
    ];
    for (const b of bad) {
      const r = classifyMissionResponse({ status: 200, body: b });
      assert.equal(r.kind, "fallback", `폴백이어야 함: ${JSON.stringify(b)?.slice(0, 60)}`);
      assert.equal((r as { reason: string }).reason, "schema");
    }
  });

  it("라우트 없는 예전 배포(404 + HTML)도 schema 폴백으로 떨어진다", () => {
    const r = classifyMissionResponse({ status: 404, body: "<!doctype html>…" });
    assert.deepEqual(r, { kind: "fallback", reason: "schema" });
  });

  it("스키마 판별기는 정상 페이로드를 통과시킨다", () => {
    assert.equal(isMissionDataPayload(okBody([base, timeless, crossMidnight])), true);
  });
});

// ── 게시 노출 판정 ──────────────────────────────────────────
describe("게시 노출 판정", () => {
  const now = "2026-08-03T12:00:00.000Z";
  it("초안·비활성·기간 밖은 노출하지 않는다", () => {
    assert.equal(isPubliclyVisible(base, now), true);
    assert.equal(isPubliclyVisible(mk({ status: "draft" }), now), false);
    assert.equal(isPubliclyVisible(mk({ status: "ended" }), now), false);
    assert.equal(isPubliclyVisible(mk({ active: false }), now), false);
    assert.equal(isPubliclyVisible(mk({ publishFrom: "2026-08-04T00:00:00Z" }), now), false);
    assert.equal(isPubliclyVisible(mk({ publishTo: "2026-08-02T00:00:00Z" }), now), false);
    assert.equal(
      isPubliclyVisible(mk({ publishFrom: "2026-08-01T00:00:00Z", publishTo: "2026-08-31T00:00:00Z" }), now),
      true,
    );
  });
});

// ── 낙관적 잠금 ─────────────────────────────────────────────
describe("낙관적 잠금", () => {
  it("changes>0 은 갱신, 0 은 충돌", () => {
    assert.equal(interpretUpdateResult(1), "updated");
    assert.equal(interpretUpdateResult(2), "updated");
    assert.equal(interpretUpdateResult(0), "conflict");
  });
});


// ── mission_source 계약 (4-2B1) ─────────────────────────────
describe("mission_source 계약", () => {
  const body = (source: string, missions: Mission[] = []) => ({
    ok: true,
    schema: MISSION_SCHEMA_VERSION,
    source,
    serverNow: "2026-08-03T12:00:00.000Z",
    missions,
  });

  it("설정값 파싱 — 모르는 값·빈 값은 dynamic", () => {
    assert.equal(parseMissionSource("static"), "static");
    assert.equal(parseMissionSource(" STATIC "), "static");
    assert.equal(parseMissionSource("dynamic"), "dynamic");
    for (const v of [null, undefined, "", "bogus", 0, {}]) {
      assert.equal(parseMissionSource(v), DEFAULT_MISSION_SOURCE, `기본값이어야 함: ${String(v)}`);
    }
  });

  it("전체 미션 비활성은 200 + dynamic + 빈 배열 (정적 폴백이 아니다)", () => {
    const r = classifyMissionResponse({ status: 200, body: body("dynamic", []) });
    assert.equal(r.kind, "empty");
    assert.equal(usesStaticConstants(r), false, "정적 상수를 쓰면 안 된다");
    assert.equal(isDegraded(r), false, "장애로 보고하면 안 된다");
  });

  it("source=static 일 때만 정적 상수를 쓴다 — 그러나 장애는 아니다", () => {
    const r = classifyMissionResponse({ status: 200, body: body("static", []) });
    assert.equal(r.kind, "static");
    assert.equal(usesStaticConstants(r), true);
    assert.equal(isDegraded(r), false, "의도된 상태이므로 오류로 보고하지 않는다");
  });

  it("장애 폴백은 정적 상수를 쓰면서 장애로도 보고한다", () => {
    for (const input of [
      { networkError: true },
      { status: 503, body: { ok: false, error: "db_unavailable" } },
      { status: 200, body: { nope: 1 } },
    ]) {
      const r = classifyMissionResponse(input);
      assert.equal(r.kind, "fallback");
      assert.equal(usesStaticConstants(r), true);
      assert.equal(isDegraded(r), true);
    }
  });

  it("source 가 없거나 계약 밖이면 스키마 폴백", () => {
    for (const s of ["bogus", "", null, undefined, 1]) {
      const b: Record<string, unknown> = { ...body("dynamic") };
      if (s === undefined) delete b.source;
      else b.source = s;
      assert.equal(classifyMissionResponse({ status: 200, body: b }).kind, "fallback", String(s));
    }
  });
});

// ── 서버 응답 결정 (200/503 경계) ───────────────────────────
describe("buildMissionData — 200/503 경계", () => {
  const now = "2026-08-03T12:00:00.000Z";

  it("D1 없음·쿼리 장애만 503", () => {
    assert.deepEqual(buildMissionData({ kind: "no_db" }), {
      status: 503,
      body: { ok: false, error: "db_unavailable" },
    });
    assert.deepEqual(buildMissionData({ kind: "query_failed" }), {
      status: 503,
      body: { ok: false, error: "query_failed" },
    });
  });

  it("미션 0건은 503 이 아니라 200 + dynamic + []", () => {
    const r = buildMissionData({ kind: "dynamic", serverNow: now, missions: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal((r.body as { source: string }).source, "dynamic");
    assert.deepEqual((r.body as { missions: unknown[] }).missions, []);
  });

  it("static 은 조회 없이 200 + static + []", () => {
    const r = buildMissionData({ kind: "static", serverNow: now });
    assert.equal(r.status, 200);
    assert.equal((r.body as { source: string }).source, "static");
    assert.deepEqual((r.body as { missions: unknown[] }).missions, []);
  });

  it("정상 응답은 전부 자기 계약을 통과한다 (서버↔클라이언트 왕복)", () => {
    for (const input of [
      { kind: "static" as const, serverNow: now },
      { kind: "dynamic" as const, serverNow: now, missions: [] },
      { kind: "dynamic" as const, serverNow: now, missions: [base] },
    ]) {
      const r = buildMissionData(input);
      assert.equal(r.status, 200);
      assert.equal(isMissionDataPayload(r.body), true, JSON.stringify(input.kind));
      const round = classifyMissionResponse({ status: r.status, body: r.body });
      assert.notEqual(round.kind, "fallback", "서버가 만든 응답이 폴백으로 분류되면 안 된다");
    }
  });

  it("503 본문은 계약을 만족하지 않는다 (= 클라이언트가 폴백으로 본다)", () => {
    const r = buildMissionData({ kind: "no_db" });
    assert.equal(isMissionDataPayload(r.body), false);
    assert.deepEqual(classifyMissionResponse({ status: r.status, body: r.body }), {
      kind: "fallback",
      reason: "server",
    });
  });
});

// ── fail-closed 쓰기 게이트 (4-2B1) ─────────────────────────
describe("쓰기 게이트 — fail-closed", () => {
  const OK = { host: "corepartners.kr", hfEnv: "production", writesEnabled: "1", allowedHosts: "corepartners.kr" };

  it("두 값이 모두 명시돼야만 허용", () => {
    assert.deepEqual(evaluateWriteAccess(OK), { allowed: true, reason: "ok" });
  });

  it("아무것도 설정하지 않으면 닫힌다 (프리뷰 기본 상태)", () => {
    assert.equal(evaluateWriteAccess({ host: "corepartners.kr" }).reason, "writes_disabled");
    assert.equal(evaluateWriteAccess({}).allowed, false);
  });

  it("ADMIN_WRITES_ENABLED 가 없거나 애매하면 거부", () => {
    for (const v of [null, undefined, "", "0", "false", "yes", "on", "enabled", " "]) {
      const r = evaluateWriteAccess({ ...OK, writesEnabled: v as string });
      assert.equal(r.allowed, false, `허용되면 안 됨: ${String(v)}`);
      assert.equal(r.reason, "writes_disabled");
    }
    for (const v of ["1", "true", "TRUE", " true "]) {
      assert.equal(evaluateWriteAccess({ ...OK, writesEnabled: v }).allowed, true, v);
    }
  });

  it("ADMIN_ALLOWED_HOSTS 가 비면 거부 — 호스트가 코드에 박혀 있지 않다", () => {
    for (const v of [null, "", "   ", ",,,"]) {
      const r = evaluateWriteAccess({ ...OK, allowedHosts: v as string });
      assert.equal(r.allowed, false, `허용되면 안 됨: ${String(v)}`);
      assert.equal(r.reason, "allowed_hosts_unset");
    }
  });

  it("허용 목록 밖 호스트는 거부", () => {
    for (const h of ["preview-abc.higgsfield.app", "localhost", "evil.example.com", "corepartners.kr.evil.com"]) {
      const r = evaluateWriteAccess({ ...OK, host: h });
      assert.equal(r.allowed, false, h);
      assert.equal(r.reason, "host_not_allowed");
    }
    assert.equal(evaluateWriteAccess({ ...OK, host: "" }).reason, "missing_host");
  });

  it("포트·대소문자·공백이 섞여도 목록과 맞춘다", () => {
    const multi = " CorePartners.KR , corepartners-dj.higgsfield.app ";
    assert.deepEqual(parseAllowedHosts(multi), ["corepartners.kr", "corepartners-dj.higgsfield.app"]);
    assert.equal(evaluateWriteAccess({ ...OK, allowedHosts: multi, host: "corepartners.kr:443" }).allowed, true);
    assert.equal(
      evaluateWriteAccess({ ...OK, allowedHosts: multi, host: "corepartners-dj.higgsfield.app" }).allowed,
      true,
    );
  });

  it("HF_ENV 는 추가 거부 조건일 뿐 — 비어 있어도 허용을 만들지 못한다", () => {
    // 비운영 env 는 두 관문을 통과해도 거부
    for (const e of ["dev", "preview", "staging", "development", "test", "LOCAL"]) {
      const r = evaluateWriteAccess({ ...OK, hfEnv: e });
      assert.equal(r.allowed, false, e);
      assert.equal(r.reason, "non_production_env");
    }
    // env 가 비어 있어도 두 관문이 닫혀 있으면 여전히 거부
    assert.equal(evaluateWriteAccess({ host: "corepartners.kr", hfEnv: null }).allowed, false);
    // env 를 모르더라도 두 관문이 열려 있으면 허용(운영 값 문자열을 추측하지 않는다)
    assert.equal(evaluateWriteAccess({ ...OK, hfEnv: null }).allowed, true);
    assert.equal(evaluateWriteAccess({ ...OK, hfEnv: "whatever-prod-name" }).allowed, true);
  });
});
