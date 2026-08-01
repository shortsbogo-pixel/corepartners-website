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
  MISSION_SCHEMA_VERSION,
  axisSegments,
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
  isMissionDataPayload,
  isPubliclyVisible,
  minutesToHHMM,
  overlaps,
  sanitizeText,
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
  const okBody = (missions: Mission[]) => ({
    ok: true,
    schema: MISSION_SCHEMA_VERSION,
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

// ── 쓰기 차단 ───────────────────────────────────────────────
describe("프리뷰·비운영 쓰기 차단", () => {
  it("운영 호스트 + 운영 env 만 허용", () => {
    assert.deepEqual(evaluateWriteAccess({ host: "corepartners.kr", hfEnv: "production" }), {
      allowed: true,
      reason: "ok",
    });
    assert.equal(evaluateWriteAccess({ host: "corepartners-dj.higgsfield.app", hfEnv: null }).allowed, true);
    assert.equal(evaluateWriteAccess({ host: "corepartners.kr:443", hfEnv: "prod" }).allowed, true);
  });

  it("프리뷰 호스트는 403", () => {
    for (const h of [
      "preview-abc.higgsfield.app",
      "corepartners-dj-preview.higgsfield.app",
      "localhost",
      "127.0.0.1",
      "evil.example.com",
    ]) {
      const r = evaluateWriteAccess({ host: h, hfEnv: "production" });
      assert.equal(r.allowed, false, `허용되면 안 됨: ${h}`);
      assert.equal(r.reason, "non_production_host");
    }
  });

  it("운영 호스트라도 비운영 env 면 403", () => {
    for (const e of ["dev", "preview", "staging", "development", "test", "LOCAL"]) {
      const r = evaluateWriteAccess({ host: "corepartners.kr", hfEnv: e });
      assert.equal(r.allowed, false, `허용되면 안 됨: ${e}`);
      assert.equal(r.reason, "non_production_env");
    }
  });

  it("호스트가 없으면 거부", () => {
    assert.equal(evaluateWriteAccess({ host: "", hfEnv: "production" }).reason, "missing_host");
    assert.equal(evaluateWriteAccess({ host: null }).allowed, false);
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
