// 주간 미션 조건(관리자 입력) 단위 테스트.
// 실행: node --experimental-strip-types --test app/tests/mission-config.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any -- 잘못된 입력을 일부러 만드는 테스트 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEFAULT_MISSION_CONFIG,
  applyMissionConfig,
  boardRows,
  man,
  manShort,
  missionKnowledgeKo,
  missionMax,
  missionSummaryEn,
  totalMax,
  validateMissionConfig,
  weeklyMax,
} from "../src/lib/mission-config.ts";
import { parseExtractResponse } from "../src/lib/mission-extract.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const coupang = readFileSync(new URL("../src/site/coupang.html", import.meta.url), "utf8");
const home = readFileSync(new URL("../src/site/home.html", import.meta.url), "utf8");

describe("기본값 = 2026.09.23~09.29 배너", () => {
  it("검증을 통과한다", () => {
    assert.equal(validateMissionConfig(DEFAULT_MISSION_CONFIG).ok, true);
  });
  it("배너의 합계와 같다: 런치 4만 · 포스트런치 7만 · 올빼미 5만2천 · 누적 12만 · 합계 28만2천", () => {
    const c = DEFAULT_MISSION_CONFIG;
    assert.equal(missionMax(c.lunch), 40000);
    assert.equal(missionMax(c.postlunch), 70000);
    assert.equal(missionMax(c.owl), 52000);
    assert.equal(weeklyMax(c), 120000);
    assert.equal(totalMax(c), 282000);
  });
});

describe("금액 표기", () => {
  it("만원 단위", () => {
    assert.equal(man(40000), "4만원");
    assert.equal(man(52000), "5만 2천원");
    assert.equal(man(282000), "28만 2천원");
    assert.equal(man(8000), "8,000원");
    assert.equal(man(52500), "5만 2,500원");
    assert.equal(manShort(282000), "28.2만");
    assert.equal(manShort(120000), "12만");
  });
});

describe("validateMissionConfig", () => {
  it("숫자 문자열(콤마·원·건)을 숫자로 바꾼다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG) as unknown as Record<string, any>;
    c.lunch.groups[0].pay = "8,000원";
    c.lunch.groups[0].count = "8건";
    const v = validateMissionConfig(c);
    assert.ok(v.ok);
    assert.equal(v.config.lunch.groups[0].pay, 8000);
    assert.equal(v.config.lunch.groups[0].count, 8);
  });
  it("같은 미션 안 요일 겹침·시간 역전·빈 요일을 막는다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.postlunch.groups[1].days = [5, 6];
    c.owl.groups[0].to = "20:00";
    c.lunch.groups[0].days = [];
    const v = validateMissionConfig(c);
    assert.equal(v.ok, false);
    const msg = (v as { errors: string[] }).errors.join("\n");
    assert.match(msg, /금요일이 다른 줄과 겹칩니다/);
    assert.match(msg, /종료 시각이 시작 시각보다 늦어야/);
    assert.match(msg, /요일을 1개 이상/);
  });
  it("주간 누적 단계는 건수·금액 모두 증가해야 한다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.weekly.tiers[2].total = 15000;
    const v = validateMissionConfig(c);
    assert.equal(v.ok, false);
  });
  it("음수·범위 밖 금액을 막는다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.perks.friend = -1;
    c.rules.cancelRateMax = 150;
    assert.equal(validateMissionConfig(c).ok, false);
  });
  it("안내 문구의 태그를 제거하고 40자로 자른다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.owl.note = "<script>x</script>앱 공지 확인" + "가".repeat(60);
    const v = validateMissionConfig(c);
    assert.ok(v.ok);
    assert.ok(!v.config.owl.note.includes("<"));
    assert.equal(v.config.owl.note.length, 40);
  });
  it("비활성 미션은 줄이 없어도 되고 합계에서 빠진다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.owl.enabled = false;
    c.owl.groups = [];
    const v = validateMissionConfig(c);
    assert.ok(v.ok);
    assert.equal(totalMax(v.config), 230000);
  });
});

describe("applyMissionConfig — 페이지 렌더링", () => {
  const out = applyMissionConfig(coupang, DEFAULT_MISSION_CONFIG);
  it("20개 마커가 모두 채워진다(마커 누락 없음)", () => {
    const names = [...coupang.matchAll(/<!--mc:([a-z0-9-]+)-->/g)].map((m) => m[1]);
    assert.equal(names.length, 20);
    for (const n of new Set(names)) assert.ok(out.includes(`<!--mc:${n}-->`));
  });
  it("배너 조건이 카드·시간표·칩·합계에 반영된다", () => {
    assert.match(out, /매일 <b>8건<\/b> 이상 완료<\/span><span class="amt tnum">8,000원/);
    assert.match(
      out,
      /토 · 일 <small[^>]*>14:00~16:54<\/small><\/div>\s*<div class="row"><span class="cond">각각 <b>12건<\/b>/,
    );
    assert.match(out, /주간 누적 150 → 350건 <b>최대 12만원<\/b>/);
    assert.match(
      out,
      /<span class="cnt tnum">190건~<\/span><span class="bar"><i><\/i><\/span><span class="plus tnum">\+2만원/,
    );
    assert.match(out, /주간 미션 최대 <!--mc:total-->28만 2천원/);
    assert.match(out, /28\.2만\+α/);
    assert.match(out, /<div class="grp-label">앱 공지 확인 후 참여<\/div>/);
    assert.ok(!out.includes("9건 달성부터"));
  });
  it("배포 스모크 테스트가 찾는 문구를 유지한다", () => {
    assert.ok(out.includes("28만 2천원"));
    assert.ok(out.includes("해당 주 금요일에 지급"));
  });
  it("시간표 배열을 JSON 으로 채우고 '<' 를 이스케이프한다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.owl.note = "</script><b>x";
    const v = validateMissionConfig(c);
    assert.ok(v.ok);
    const html = applyMissionConfig(coupang, v.config);
    const tt = /\/\*mc:timetable\*\/([\s\S]*?)\/\*\/mc:timetable\*\//.exec(html)![1];
    const rows = JSON.parse(tt);
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[1], {
      name: "포스트런치",
      days: [1, 2, 3, 4, 5],
      from: 13,
      to: 16.9,
      d: "월~금",
      tm: "13:00~16:54",
      pay: "각각 12건 10,000",
    });
    assert.ok(!html.includes("</script><b>x"), "태그 제거·이스케이프");
  });
  it("비활성 미션은 카드에 hidden 이 붙고 시간표·합계에서 빠진다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.lunch.enabled = false;
    const html = applyMissionConfig(coupang, c);
    assert.match(html, /data-mc-card="lunch" hidden/);
    assert.ok(!boardRows(c).some((r) => r.name === "평일런치"));
    assert.ok(html.includes("24만 2천원"));
    // 다시 켜면 hidden 이 사라진다(렌더링을 반복해도 안정)
    assert.match(applyMissionConfig(html, DEFAULT_MISSION_CONFIG), /data-mc-card="lunch">/);
  });
  it("홈 요약 문구도 채운다", () => {
    const c = clone(DEFAULT_MISSION_CONFIG);
    c.weekly.tiers[5].total = 150000;
    assert.ok(
      applyMissionConfig(home, c).includes("주간 최대 <!--mc:total-->31만 2천원<!--/mc:total-->+α"),
    );
  });
});

describe("챗봇 · llms.txt 텍스트", () => {
  it("챗봇 지식에 현재 조건이 들어간다", () => {
    const t = missionKnowledgeKo(DEFAULT_MISSION_CONFIG);
    assert.match(t, /주간 최대 28만 2천원/);
    assert.match(t, /평일런치\(월~금 10:55~12:59, 월~금 10:55~12:59 매일 8건 8,000원/);
    assert.match(t, /야간 올빼미\(21:00~23:59, 월·화 합산 20건 14,000원/);
    assert.match(t, /150건 1만원 → 180건 2만원 → 190건 4만원/);
    assert.ok(!t.includes("31만"));
  });
  it("llms.txt 요약", () => {
    const t = missionSummaryEn(DEFAULT_MISSION_CONFIG);
    assert.match(t, /Mon\/Tue\/Wed\/Thu\/Fri 10:55-12:59, 8 completed deliveries, KRW 8,000/);
    assert.match(t, /KRW 282,000/);
  });
});

describe("parseExtractResponse — AI 응답 해석", () => {
  const good = {
    period: { start: "2026-09-23", end: "2026-09-29" },
    config: DEFAULT_MISSION_CONFIG,
    uncertain: ["포스트런치 주말 시작 시각"],
  };
  it("앞뒤 설명이 붙어도 JSON 을 꺼내 검증한다", () => {
    const r = parseExtractResponse("여기 결과입니다\n" + JSON.stringify(good) + "\n끝");
    assert.ok(r.ok);
    assert.deepEqual(r.period, { start: "2026-09-23", end: "2026-09-29" });
    assert.equal(totalMax(r.config), 282000);
    assert.deepEqual(r.uncertain, ["포스트런치 주말 시작 시각"]);
  });
  it("검증 실패면 저장 가능한 값으로 넘기지 않는다", () => {
    const bad = clone(good) as Record<string, any>;
    bad.config.lunch.groups[0].pay = null;
    const r = parseExtractResponse(JSON.stringify(bad));
    assert.equal(r.ok, false);
  });
  it("JSON 이 아니면 실패", () => {
    assert.equal(parseExtractResponse("죄송합니다").ok, false);
    assert.equal(parseExtractResponse("{ 깨진").ok, false);
  });
});
