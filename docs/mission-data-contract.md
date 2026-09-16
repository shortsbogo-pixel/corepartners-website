# `/mission-data` 응답 계약과 정적 폴백 규칙

4-2B 에서 확정. 미션보드(4-2D)와 관리자 미리보기(4-2C)는 이 계약만 보고 만든다.
구현은 `app/src/lib/missions.ts` 의 `classifyMissionResponse` 가 단일 판정지점이며,
클라이언트는 이 함수와 같은 규칙을 따라야 한다.

## 성공 응답 (200)

```json
{
  "ok": true,
  "schema": 1,
  "source": "dynamic",
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
- `source` : `dynamic` | `static`. 그 밖의 값이거나 없으면 **스키마 폴백**으로 간다.

## `source` — 동적/정적 전환 (4-2B1)

`ops_settings` 테이블의 `mission_source` 행이 값을 정한다. **행이 없으면 `dynamic`** 이
기본이라 초기 데이터를 심을 필요가 없다.

| 설정 | 서버 동작 | 보드 동작 |
|---|---|---|
| 없음 · `dynamic` | 게시 미션을 조회해 돌려준다 | 받은 데이터로 렌더 |
| `static` | **조회하지 않고** `source:"static"`, `missions:[]` | 코드 내 정적 `MISSIONS` 상수로 렌더 |

`static` 은 **장애가 아니라 운영자가 의도한 상태**다. 정적 상수를 쓴다는 점은
장애 폴백과 같지만 오류로 보고하지 않는다. 코드에서는
`usesStaticConstants()`(상수를 쓰는가)와 `isDegraded()`(장애인가)를 나눠 쓴다.

전환은 **데이터 변경만으로 즉시 적용된다.** 힉스필드 시크릿은 다음
`deploy_website` 전까지 반영되지 않으므로 킬스위치를 시크릿이 아니라 이 테이블에
둔 것이다.

## 실패 응답 (503)

```json
{ "ok": false, "error": "db_unavailable" | "query_failed" }
```

마이그레이션 전(테이블 없음)도 `query_failed` 로 여기 들어온다.
**정상 빈 상태와 구분하기 위해 200 + 빈 배열을 절대 돌려주지 않는다.**

## 판정 규칙

| 상황 | 판정 | 보드 동작 |
|---|---|---|
| 200 + `source:"dynamic"` + `missions.length > 0` | `data` | 받은 데이터로 렌더 |
| 200 + `source:"dynamic"` + `missions.length === 0` | **`empty`** | **빈 상태 문구.** 정적 상수로 되돌아가지 않는다. **전체 미션 비활성·게시 기간 밖이 여기다** |
| 200 + `source:"static"` | **`static`** | 정적 상수로 렌더. **오류로 보고하지 않는다** |
| fetch 자체 실패 | `fallback` / `network` | 코드 내 정적 `MISSIONS` 상수로 렌더 |
| 상태코드 ≥ 500 | `fallback` / `server` | 〃 |
| 본문이 계약 불일치 | `fallback` / `schema` | 〃 |

4xx(라우트가 없는 예전 배포의 404 HTML 포함)는 본문이 계약을 만족하지 못하므로
자연히 `schema` 로 떨어진다. "네트워크 · 5xx · 스키마만 폴백" 규칙을 그대로 지키기
위해 4xx 전용 분기를 두지 않는다.

## 정적 폴백의 정체

`app/src/site/coupang.html` 안의 `MISSIONS` 상수를 **삭제하지 않고 남긴 것**이
정적 상수의 실체다. `static` 과 `fallback` 두 경우에만 쓰인다.

강제 정적 전환은 **`ops_settings.mission_source` 를 `'static'` 으로 바꾸는 것**이며
데이터 변경이므로 **재배포 없이 즉시 적용된다.**

⚠ 계획 초안의 "시크릿 `MISSION_SOURCE=static` 으로 배포 없이 즉시 전환" 은 **사실이
아니다.** 힉스필드에서 시크릿 변경은 스테이징만 되고 다음 `deploy_website` 전까지
반영되지 않는다. 그래서 킬스위치를 시크릿이 아니라 D1 테이블로 옮겼다.

## 관리자 쓰기 게이트 (fail-closed)

`/mission-data` 는 읽기 전용이라 이 게이트와 무관하지만, 4-2C 의 쓰기 API 는
`evaluateWriteAccess()` 를 통과해야 한다.

| 환경변수 | 필수 | 의미 |
|---|---|---|
| `ADMIN_WRITES_ENABLED` | ✅ | `1` 또는 `true` 일 때만 켜진다 |
| `ADMIN_ALLOWED_HOSTS` | ✅ | 쉼표 구분 호스트 목록. 비면 거부 |
| `HF_ENV` | — | **추가 거부 조건으로만** 쓴다. 비어 있어도 허용을 만들지 못한다 |

둘 다 명시된 배포에서만 열린다. **프리뷰는 아무것도 설정하지 않는 것만으로 닫힌다.**
운영 호스트를 코드 상수로 박아 두지 않은 이유는, 박아 두면 그 상수가 두 번째 진실
공급원이 되어 프리뷰가 우연히 같은 호스트를 갖는 순간 열리기 때문이다.

4-2C 의 로그인·부트스트랩도 이 게이트를 통과해야 한다. 세션 발급이 그 자체로 쓰기이고,
preview 와 production 이 D1 을 공유하기 때문이다. 세션 계약은 `admin-auth-contract.md` 참고.

## 렌더 규칙 (4-2D 가 지킬 것)

- 관리자가 입력한 문자열(`name` · `note` · `daysLabel`)은 **`innerHTML` 에 넣지
  않는다.** `textContent` 로 넣거나 `escapeHtml()` 을 통과시킨다.
  현재 `coupang.html` 의 보드는 `row.innerHTML = …` 로 렌더하므로 그대로 두면
  저장형 XSS 경로가 된다.
- 자정을 넘는 미션은 축(10:00~24:00)을 벗어나는 조각이 잘린다
  (`axisSegments()` 참고). 잘린 정보가 사라지지 않도록 라벨 열에
  `21:30~익일 01:30` 처럼 표기한다.
- `timeless` 상태 미션은 막대가 아니라 칩으로 렌더한다.
