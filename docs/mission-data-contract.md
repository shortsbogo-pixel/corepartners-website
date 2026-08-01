# `/mission-data` 응답 계약과 정적 폴백 규칙

4-2B 에서 확정. 미션보드(4-2D)와 관리자 미리보기(4-2C)는 이 계약만 보고 만든다.
구현은 `app/src/lib/missions.ts` 의 `classifyMissionResponse` 가 단일 판정지점이며,
클라이언트는 이 함수와 같은 규칙을 따라야 한다.

## 성공 응답 (200)

```json
{
  "ok": true,
  "schema": 1,
  "serverNow": "2026-08-03T03:00:00.000Z",
  "missions": [
    {
      "id": "…", "name": "평일런치", "type": "regular", "groupKey": "lunch",
      "dayMask": 62, "startMin": 655, "endMin": 779, "endDayOffset": 0,
      "daysLabel": null, "note": null,
      "publishFrom": null, "publishTo": null,
      "active": true, "sortOrder": 0, "status": "published", "version": 1,
      "tiers": [
        { "targetCount": 10, "rewardAmount": 7000,  "sortOrder": 0 },
        { "targetCount": 13, "rewardAmount": 10000, "sortOrder": 1 }
      ]
    }
  ]
}
```

- `dayMask` : bit0=일 … bit6=토. 0 = 요일 무관.
- `startMin` / `endMin` : 자정 기준 분. 둘 다 `null` 이면 시간 무관 미션(칩으로 렌더).
- `endDayOffset` : 1 이면 자정을 넘겨 다음 날 `endMin` 에 끝난다.
- `serverNow` : 서버 UTC 시각. 클라이언트 시계가 틀릴 수 있으므로 LIVE 판정은
  `serverNow` 와의 오차를 보정한 뒤 한다.
- `schema` : 계약 버전. 값이 다르면 **스키마 폴백**으로 간다.

## 실패 응답 (503)

```json
{ "ok": false, "error": "db_unavailable" | "query_failed" }
```

마이그레이션 전(테이블 없음)도 `query_failed` 로 여기 들어온다.
**정상 빈 상태와 구분하기 위해 200 + 빈 배열을 절대 돌려주지 않는다.**

## 판정 규칙

| 상황 | 판정 | 보드 동작 |
|---|---|---|
| 200 + 계약 만족 + `missions.length > 0` | `data` | 받은 데이터로 렌더 |
| 200 + 계약 만족 + `missions.length === 0` | **`empty`** | **빈 상태 문구.** 정적 상수로 되돌아가지 않는다 |
| fetch 자체 실패 | `fallback` / `network` | 코드 내 정적 `MISSIONS` 상수로 렌더 |
| 상태코드 ≥ 500 | `fallback` / `server` | 〃 |
| 본문이 계약 불일치 | `fallback` / `schema` | 〃 |

4xx(라우트가 없는 예전 배포의 404 HTML 포함)는 본문이 계약을 만족하지 못하므로
자연히 `schema` 로 떨어진다. "네트워크 · 5xx · 스키마만 폴백" 규칙을 그대로 지키기
위해 4xx 전용 분기를 두지 않는다.

## 정적 폴백의 정체 — 무배포 전환이 아니다

`app/src/site/coupang.html` 안의 `MISSIONS` 상수를 **삭제하지 않고 남긴 것**이
폴백의 실체다. 위 표의 `fallback` 세 경우에만 이 상수가 쓰인다.

⚠ 계획 초안에 적었던 "시크릿 `MISSION_SOURCE=static` 으로 배포 없이 즉시 정적
전환" 은 **사실이 아니다.** 힉스필드에서 시크릿 변경은 스테이징만 되고 다음
`deploy_website` 전까지 반영되지 않는다. 따라서 강제 정적 전환은

1. 시크릿 설정 → **재배포 1회** 가 필요하거나,
2. 재배포 없이 즉시 되돌려야 한다면 `/mission-data` 를 503 으로 만드는 조치
   (예: 미션 전체 비활성화 = 데이터 변경) 로 해야 한다.

2번은 데이터 변경만으로 되므로 실질적인 즉시 수단이다. 정확한 강제 전환 절차는
4-2D 에서 확정한다.

## 렌더 규칙 (4-2D 가 지킬 것)

- 관리자가 입력한 문자열(`name` · `note` · `daysLabel`)은 **`innerHTML` 에 넣지
  않는다.** `textContent` 로 넣거나 `escapeHtml()` 을 통과시킨다.
  현재 `coupang.html` 의 보드는 `row.innerHTML = …` 로 렌더하므로 그대로 두면
  저장형 XSS 경로가 된다.
- 자정을 넘는 미션은 축(10:00~24:00)을 벗어나는 조각이 잘린다
  (`axisSegments()` 참고). 잘린 정보가 사라지지 않도록 라벨 열에
  `21:30~익일 01:30` 처럼 표기한다.
- `timeless` 상태 미션은 막대가 아니라 칩으로 렌더한다.
