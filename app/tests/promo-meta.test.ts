// 주간 배너 메타(promo-meta) 규칙 단위 테스트.
// 실행: node --experimental-strip-types --test app/tests/promo-meta.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPromoMeta, cleanField, isBannerVersion } from "../src/lib/promo-meta.ts";

// 2026-09-23 03:30 KST
const NOW = new Date("2026-09-22T18:30:00Z");

describe("buildPromoMeta", () => {
  it("라벨·시작일·종료일을 그대로 저장하고 기간 문자열을 만든다", () => {
    const r = buildPromoMeta(
      { label: "2026년 9월 4주차", start: "2026-09-23", end: "2026-09-29" },
      NOW,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.meta, {
      label: "2026년 9월 4주차",
      period: "2026.09.23 ~ 2026.09.29",
      start: "2026-09-23",
      end: "2026-09-29T23:59:59+09:00",
      updated: "2026.09.23", // KST 날짜 (UTC로는 아직 22일)
      v: String(NOW.getTime()),
    });
  });

  it("기간 없이 올리면 지난 주 기간을 이어받지 않고 빈 값으로 새로 쓴다", () => {
    const r = buildPromoMeta({ label: "", start: "", end: "" }, NOW);
    assert.ok(r.ok);
    assert.equal(r.meta.period, "");
    assert.equal(r.meta.end, "");
    assert.equal(r.meta.label, "");
    assert.equal(r.meta.v, String(NOW.getTime()));
  });

  it("업로드마다 버전이 달라진다", () => {
    const a = buildPromoMeta({ label: "", start: "", end: "" }, NOW);
    const b = buildPromoMeta({ label: "", start: "", end: "" }, new Date(NOW.getTime() + 1000));
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.meta.v, b.meta.v);
  });

  it("시작일·종료일 중 하나만 있으면 거부", () => {
    assert.equal(buildPromoMeta({ label: "x", start: "2026-09-23", end: "" }, NOW).ok, false);
    assert.equal(buildPromoMeta({ label: "x", start: "", end: "2026-09-29" }, NOW).ok, false);
  });

  it("종료일이 시작일보다 빠르면 거부", () => {
    assert.equal(
      buildPromoMeta({ label: "x", start: "2026-09-29", end: "2026-09-23" }, NOW).ok,
      false,
    );
  });

  it("존재하지 않는 날짜·형식 오류는 거부", () => {
    assert.equal(
      buildPromoMeta({ label: "x", start: "2026-02-30", end: "2026-03-01" }, NOW).ok,
      false,
    );
    assert.equal(
      buildPromoMeta({ label: "x", start: "2026.09.23", end: "2026.09.29" }, NOW).ok,
      false,
    );
  });

  it("같은 날 시작·종료는 허용", () => {
    assert.equal(
      buildPromoMeta({ label: "x", start: "2026-09-23", end: "2026-09-23" }, NOW).ok,
      true,
    );
  });
});

describe("cleanField", () => {
  it("태그를 제거하고 길이를 자른다", () => {
    assert.equal(cleanField("<b>9월</b> 4주차<script>x</script>", 60), "9월 4주차x");
    assert.equal(cleanField("  abcdef  ", 3), "abc");
    assert.equal(cleanField(null, 10), "");
  });
});

describe("isBannerVersion", () => {
  it("숫자 버전만 인정", () => {
    assert.equal(isBannerVersion("1790101800000"), true);
    assert.equal(isBannerVersion(null), false);
    assert.equal(isBannerVersion(""), false);
    assert.equal(isBannerVersion("abc"), false);
    assert.equal(isBannerVersion("1".repeat(17)), false);
  });
});
