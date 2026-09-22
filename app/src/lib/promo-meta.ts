// Pure rules for the weekly promo metadata saved next to the banner image
// (R2 key `promo-meta`). No Workers imports, so it runs under `node --test`.
//
// Shape written by /api/promo-upload and read by /promo-meta, coupang.html and
// home.html. `label`, `period`, `updated`, `end` are the original fields (kept
// for compatibility); `start` and `v` were added so the public page can show the
// saved dates and cache-bust the banner image URL.

export type PromoMeta = {
  label: string; // 주차 라벨, e.g. "2026년 9월 4주차"
  period: string; // "2026.09.23 ~ 2026.09.29" or "" when dates were not given
  start: string; // "2026-09-23" or ""
  end: string; // "2026-09-29T23:59:59+09:00" or ""
  updated: string; // KST upload date "2026.09.23"
  v: string; // banner version = upload instant in ms (string), used as ?v=
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** Strip tags and trim to `max` chars — same sanitising the upload always did. */
export function cleanField(raw: unknown, max: number): string {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, max);
}

export type PromoMetaInput = { label: string; start: string; end: string };

export type PromoMetaResult = { ok: true; meta: PromoMeta } | { ok: false; error: string };

/**
 * Build the metadata saved with every banner upload.
 *
 * Always returns a fresh object (never merges with the previous week's meta):
 * an image uploaded without dates must not inherit last week's period, which
 * is how a new banner ended up paired with an expired period.
 */
export function buildPromoMeta(input: PromoMetaInput, now: Date): PromoMetaResult {
  const label = input.label;
  const start = input.start;
  const end = input.end;

  if (start && !isValidDate(start)) return { ok: false, error: "시작일 형식이 올바르지 않습니다." };
  if (end && !isValidDate(end)) return { ok: false, error: "종료일 형식이 올바르지 않습니다." };
  if ((start && !end) || (!start && end)) {
    return { ok: false, error: "적용 기간은 시작일과 종료일을 함께 입력해 주세요." };
  }
  if (start && end && end < start) {
    return { ok: false, error: "종료일이 시작일보다 빠릅니다." };
  }

  const fmt = (d: string) => d.replaceAll("-", ".");
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const updated = `${kst.getUTCFullYear()}.${String(kst.getUTCMonth() + 1).padStart(2, "0")}.${String(
    kst.getUTCDate(),
  ).padStart(2, "0")}`;

  return {
    ok: true,
    meta: {
      label,
      period: start && end ? `${fmt(start)} ~ ${fmt(end)}` : "",
      start,
      end: end ? `${end}T23:59:59+09:00` : "",
      updated,
      v: String(now.getTime()),
    },
  };
}

/** `?v=` values are digits only; anything else is treated as unversioned. */
export function isBannerVersion(v: string | null): boolean {
  return !!v && /^\d{1,16}$/.test(v);
}
