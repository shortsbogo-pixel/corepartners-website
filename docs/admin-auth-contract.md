# 관리자 세션 인증 계약 (4-2C)

4-2C 에서 확정. 미션 쓰기 API(4-2C 후속)와 관리자 화면(4-2D)은 이 계약만 보고 만든다.
규칙은 `app/src/lib/admin-auth.ts` 에, D1 접근은 `app/src/lib/admin-auth.server.ts` 에 있다.

## 왜 세션인가

현행 `/admin` 과 `/api/promo-upload` 는 `?key=<ADMIN_KEY>` 단일 시크릿을 쓴다.

- 시크릿이 URL 에 실려 브라우저 히스토리·Referer·액세스 로그에 남는다.
- 만료도, 개별 회수도 없다. 한 명이 유출하면 전원이 바뀌어야 한다.
- 무엇보다 **누가 바꿨는지 식별할 수 없다.** `mission_audit.actor` 를 채울 수 없다.

세 번째가 결정적이다. 감사 로그는 첫 쓰기부터 필수(승인 조건 10)인데 단일 시크릿으로는
actor 를 적을 수 없다.

## 엔드포인트

| 경로 | 메서드 | 쓰기 게이트 | 용도 |
|---|---|---|---|
| `/api/admin/bootstrap` | POST | ✅ | 최초 계정 1회 생성 |
| `/api/admin/login` | POST | ✅ | 아이디·비밀번호 → 세션 쿠키 |
| `/api/admin/session` | GET | — | 현재 세션 확인 |
| `/api/admin/logout` | POST | — | 세션 회수 + 쿠키 삭제 |

모든 응답은 `Cache-Control: no-store` 다.

### POST `/api/admin/login`

```json
{ "username": "core.admin", "password": "…" }
```

| 상태 | 본문 | 비고 |
|---|---|---|
| 200 | `{ ok:true, user:{id,username,role}, expiresAt }` | `Set-Cookie` 동봉 |
| 400 | `{ ok:false, error:"bad_json" \| "missing_credentials" }` | |
| 401 | `{ ok:false, error:"invalid_credentials" }` | **없는 아이디 · 잠긴 계정 · 틀린 비밀번호가 전부 같은 응답이다** |
| 403 | `{ ok:false, error:"write_forbidden" \| "cross_origin" }` | |
| 429 | `{ ok:false, error:"too_many_attempts", retryAfterSec }` | `Retry-After` 동봉 |
| 503 | `{ ok:false, error:"db_unavailable" }` | |

401 을 하나로 묶는 이유는 계정 열거 방지다. 응답 시간으로도 알아낼 수 없도록 아이디가
없을 때에도 **같은 비용의 더미 해싱을 돌린다**(`burnPasswordTime`).

### GET `/api/admin/session`

200 `{ ok:true, user, canWrite, expiresAt }` — `canWrite` 는 역할이 `admin`·`editor` 일 때만 참이다.
401 은 `no_session` · `session_expired` · `session_revoked` · `user_disabled` 로 나뉘며,
쿠키가 살아 있는데 세션이 죽은 경우(뒤 셋)에만 쿠키를 지워 보낸다.

### POST `/api/admin/logout`

**멱등이며 언제나 200 이다.** 세션이 없어도, D1 이 없어도 쿠키를 지우고 성공으로 답한다.
실패로 답하면 쿠키가 남은 채 로그아웃 버튼이 계속 실패하는 상태에 갇힌다.
행은 지우지 않고 `revoked=1` 로 둬서 만료 스윕까지 흔적을 남긴다.

## 세션

| 항목 | 값 | 이유 |
|---|---|---|
| 쿠키 이름 | `cp_admin_session` | |
| 속성 | `HttpOnly; Secure; SameSite=Strict; Path=/` | Secure 는 `http://localhost`·`127.0.0.1` 에서만 빠진다 |
| 수명 | 12시간(절대) | |
| 연장 | 남은 시간 < TTL 의 1/4 | 요청마다 UPDATE 를 치지 않기 위한 임계 |
| 토큰 | 256비트 난수 → base64url | |
| 저장값 | 토큰의 **SHA-256 hex 만** 저장 | DB 가 통째로 새도 세션을 재사용할 수 없다 |

`SameSite=Strict` 라 외부 링크로 관리자 화면에 처음 들어오면 쿠키가 실리지 않아 로그아웃처럼
보인다. 새로고침하면 붙는다. 그 대신 CSRF 가 브라우저 단계에서 끊긴다.
2차 방어로 `Origin` 헤더가 **있으면** 호스트 일치를 요구한다(없으면 통과 — 브라우저가 아닌
클라이언트는 쿠키를 자동으로 싣지 않아 CSRF 대상이 아니다).

**쿠키 셰도잉**: 같은 이름의 쿠키가 둘 이상 오면 세션이 없는 것으로 본다. 상위 도메인에서
심은 쿠키와 순서가 보장되지 않아, 어느 쪽을 골라도 공격자가 고른 값을 쓸 위험이 있다.

## 비밀번호

PBKDF2-SHA256, 계정별 16바이트 소금, **반복 수 210,000**(0006 의 `pw_iterations` 기본값과
같다. `CHECK >= 100000`). 반복 수는 계정마다 저장하므로 나중에 올려도 기존 계정은 각자
저장된 값으로 계속 검증된다.

입력은 NFKC 로 정규화한다 — 입력기에 따라 같은 비밀번호가 다른 바이트열이 되는 일을 막는다.
규칙은 **길이만** 본다(12자 이상 200자 이하, 제어문자 금지). 문자 종류 강제는 `Passw0rd!`
같은 예측 가능한 변형을 부를 뿐이다.

⚠ 210k 반복은 로그인 요청 하나당 100~200ms 의 CPU 를 쓴다. Workers 의 CPU 한도가 빠듯한
요금제에서는 로그인만 실패할 수 있다. 이 값은 스키마가 정한 것이라 낮추려면 마이그레이션이
필요하다(최소 100,000).

## 로그인 잠금

`admin_login_attempts` 한 테이블로 두 층을 강제한다. 창은 **15분 고정 창**이다.

| 층 | 키 | 한도 | 막는 것 |
|---|---|---|---|
| 1 | `(ip, username)` | 5회 | 특정 계정 표적 대입 |
| 2 | `ip` 합산 | 20회 | 아이디를 바꿔 가며 훑는 계정 열거 |

IP 만으로 잡으면 사무실·모바일망처럼 여러 관리자가 공인 IP 하나를 쓸 때 한 사람의 오타가
나머지를 잠그고, 아이디만으로 잡으면 분산 IP 공격을 놓친다.

- 실패는 **아이디가 있든 없든 똑같이** 집계한다. 없는 아이디만 빠지면 그 차이로 계정 존재를
  알 수 있고, 없는 아이디는 무한히 시도할 수 있게 된다.
- 성공하면 **그 조합만** 지운다. 같은 IP 의 다른 아이디 집계는 남겨 열거 탐지를 유지한다.
- 집계를 읽지 못하면 **잠긴 것으로 본다**(503). 여기서 통과시키면 테이블 장애 한 번이
  무차별 대입 방어를 통째로 끈다.
- 만료 세션 스윕과 지난 창 정리는 **성공한 로그인의 batch 에 끼워 넣는다.** cron 이 없으므로
  관리자 로그인이 정리를 돌릴 유일한 정기 경로다.

## 쓰기 게이트와의 관계

로그인과 부트스트랩도 `evaluateWriteAccess()` 를 통과해야 한다
(`ADMIN_WRITES_ENABLED` + `ADMIN_ALLOWED_HOSTS`, 상세는 `mission-data-contract.md`).

**세션 발급은 그 자체가 쓰기다.** preview 와 production 이 D1 하나를 공유하므로, 게이트가
없으면 아무 preview 배포에서나 세션을 만들어 production 에서 쓸 수 있고, 첫 계정을 선점할
수도 있다. 아무것도 설정하지 않은 배포는 **로그인 자체가 닫힌다.**

반대로 로그아웃과 세션 확인에는 게이트를 걸지 않는다. 로그아웃은 권한을 **줄이는** 쪽이라
어떤 배포에서도 열려 있어야 하고, 세션 확인은 읽기다.

## 최초 계정 만들기

마이그레이션에 계정 INSERT 를 넣지 않은 이유는 preview 배포마다 재실행될 수 있어 시크릿이
박힌 계정이 지워도 되살아나기 때문이다. 대신 1회용 부트스트랩을 쓴다.

1. 운영 배포에 `ADMIN_BOOTSTRAP_SECRET` 을 넣는다 (`ADMIN_WRITES_ENABLED`,
   `ADMIN_ALLOWED_HOSTS` 는 이미 있어야 한다).
2. 운영 호스트로 한 번 호출한다.

   ```bash
   curl -sS https://<운영호스트>/api/admin/bootstrap \
     -H 'Content-Type: application/json' \
     -d '{"secret":"…","username":"core.admin","password":"…"}'
   ```

3. 201 을 받으면 **`ADMIN_BOOTSTRAP_SECRET` 을 지우고 재배포한다.**

이 경로는 두 겹으로 닫힌다 — 시크릿을 지우면 `bootstrap_disabled`, 시크릿이 남아 있어도
계정이 이미 있으면 `already_bootstrapped`(409).

## 역할

`admin` · `editor` · `viewer` 세 가지이며, 모르는 값은 **가장 약한 `viewer`** 로 떨어진다.
미션을 바꿀 수 있는 역할은 `admin` 과 `editor` 다(`canWriteMissions`). `viewer` 는 미리보기만 한다.

## 일부러 만들지 않은 것

- **`ADMIN_KEY` ↔ 세션 교환 경로.** 0006 은 세션 교환 경로에 한해 `ADMIN_KEY` 를 허용하지만,
  그 경로를 만들면 URL 에 실리는 단일 시크릿이 계속 살아 있게 된다. 최초 계정은 부트스트랩이
  만들고 그 뒤로는 비밀번호 로그인만 쓴다.
- **기존 `/admin?key=` 화면은 이번에 건드리지 않았다.** 미션 쓰기 API 는 세션만 받으므로
  (`ADMIN_KEY` 병행 허용 금지 — 승인된 D2/B안), 그 화면이 미션을 건드릴 수 있게 되는 시점에
  같이 옮긴다.
- **계정 관리 화면**(추가·비활성·비밀번호 변경). 계정이 늘어날 때 만든다. 지금은 부트스트랩
  계정 하나로 충분하고, `disabled=1` 과 세션 회수는 이미 코드가 존중한다.

## 검증

- `app/tests/admin-auth.test.ts` — 도메인 49건 (`bun test`)
- `app/tests/schema_test.py` — 스키마·SQL 39건. 4-2C 절은 **출하되는 SQL 원문을
  `admin-auth.server.ts` 에서 뽑아** 실제 SQLite 엔진에 돌린다. 테스트용으로 옮겨 적으면
  둘이 갈라진 것을 아무도 모르게 되므로 복사하지 않는다.
