// 배너 이미지 → 미션 조건 JSON 추출(AI) — 프롬프트와 응답 해석(순수 모듈).
// AI 결과는 초안일 뿐이다. 관리자 화면에 채워 넣고, 사람이 배너와 대조·확인한 뒤에만 저장된다.
import { type MissionConfig, validateMissionConfig } from "./mission-config.ts";

export const EXTRACT_MODEL = "claude-sonnet-5";
export const EXTRACT_FALLBACK_MODEL = "claude-haiku-4-5";

export const EXTRACT_PROMPT = `이 이미지는 배달 라이더용 "주간 미션 프로모션" 배너입니다.
배너에 적힌 조건만 읽어서 아래 JSON 형식 하나로 답하세요. 설명·마크다운·코드블록 없이 JSON만 출력합니다.
배너에 없는 값은 추측하지 말고 null 로 두세요.

{
  "period": { "start": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null },
  "config": {
    "lunch":     { "enabled": true, "basis": "daily", "note": "", "groups": [ { "days": [1,2,3,4,5], "from": "10:55", "to": "12:59", "count": 8, "pay": 8000 } ] },
    "postlunch": { "enabled": true, "basis": "daily", "note": "", "groups": [ ... ] },
    "owl":       { "enabled": true, "basis": "sum",   "note": "", "groups": [ ... ] },
    "weekly": { "tiers": [ { "count": 150, "total": 10000 } ] },
    "perks": { "friend": 50000, "welcomeCount": 150, "welcomePay": 30000, "gearCount": 100 },
    "rules": { "cancelRateMax": 10, "duplicate": true }
  },
  "uncertain": [ "읽기 애매했던 항목을 한국어로 짧게" ]
}

규칙:
- days 는 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토. "평일"=[1,2,3,4,5], "주말"=[0,6], "매일/월~일"=[0,1,2,3,4,5,6].
- 같은 미션 안에서 요일이 다르거나 시간이 다르면 groups 를 나눕니다. 예: "평일 13:00~16:54 · 주말 14:00~16:54, 매일 12건 10,000원"
  → [{days:[1,2,3,4,5],from:"13:00",to:"16:54",count:12,pay:10000},{days:[0,6],from:"14:00",to:"16:54",count:12,pay:10000}]
- lunch=평일 런치, postlunch=포스트런치, owl=올빼미(야간). 배너에 없는 미션은 enabled:false, groups:[].
- basis: 요일마다 따로 달성·지급이면 "daily", "합산"(요일 묶음을 합쳐 한 번 지급)이면 "sum".
- 한 요일 묶음의 합산 조건(예: "수·목·금 합산 27건 22,000원")은 그 묶음 하나가 group 하나입니다.
- weekly.tiers 의 total 은 그 단계까지의 "누적" 보상 금액(원)입니다. 배너가 단계별 누적 금액을 보여 주면 그대로, 단계별 추가 금액만 보여 주면 더해서 누적으로 바꿉니다.
- 금액은 원 단위 정수(8,000원 → 8000, 5만원 → 50000). 시간은 "HH:MM" 24시간제.
- "모두 달성 시 총 N원" 같은 합계는 입력하지 않습니다(자동 계산됨). 대신 계산이 맞지 않으면 uncertain 에 적습니다.
- note 에는 "앱 공지 확인 후 참여" 같은 짧은 참여 조건만 40자 이내로 적습니다.`;

export type ExtractResult =
  | { ok: true; config: MissionConfig; period: { start: string; end: string }; uncertain: string[] }
  | { ok: false; error: string; errors?: string[]; draft?: unknown; uncertain?: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 모델 응답 텍스트에서 JSON 을 꺼내 검증한다. */
export function parseExtractResponse(text: string): ExtractResult {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return { ok: false, error: "AI 응답에서 조건을 찾지 못했습니다." };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "AI 응답 형식을 해석하지 못했습니다." };
  }
  const uncertain = Array.isArray(obj.uncertain)
    ? obj.uncertain
        .map((u) =>
          String(u)
            .replace(/<[^>]*>/g, "")
            .slice(0, 120),
        )
        .slice(0, 10)
    : [];
  const per = (obj.period && typeof obj.period === "object" ? obj.period : {}) as Record<
    string,
    unknown
  >;
  const period = {
    start: typeof per.start === "string" && DATE_RE.test(per.start) ? per.start : "",
    end: typeof per.end === "string" && DATE_RE.test(per.end) ? per.end : "",
  };
  const v = validateMissionConfig(obj.config);
  if (!v.ok) {
    return {
      ok: false,
      error: "AI가 읽은 조건 중 확인이 필요한 항목이 있습니다.",
      errors: v.errors,
      draft: obj.config,
      uncertain,
    };
  }
  return { ok: true, config: v.config, period, uncertain };
}
