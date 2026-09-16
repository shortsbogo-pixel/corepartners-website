#!/usr/bin/env python3
"""4-2B 스키마 검증 — 마이그레이션 SQL 을 실제 SQLite 엔진에 적용해
CHECK / UNIQUE / FOREIGN KEY 가 의도대로 막는지 확인한다.

실행: python3 app/tests/schema_test.py
D1 은 SQLite 기반이므로 제약 동작은 여기서 재현된다. 다만 D1 의 read replica,
batch 트랜잭션, PRAGMA 기본값은 재현 대상이 아니다(그 부분은 4-2C 실환경 확인).
"""
import pathlib
import re
import sqlite3
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = ["migrations/0001_init.sql", "migrations/0002_applications.sql",
              "migrations/0003_chat.sql", "migrations/0004_chat_logs.sql",
              "migrations/0005_missions.sql", "migrations/0006_admin_auth.sql",
              "migrations/0007_ops_settings.sql"]

passed, failed = 0, 0


def check(label, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print("  ok   %s" % label)
    except AssertionError as e:
        failed += 1
        print("  FAIL %s -- %s" % (label, e))
    except Exception as e:
        failed += 1
        print("  FAIL %s -- %s: %s" % (label, type(e).__name__, e))


def fresh():
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys = ON")
    for m in MIGRATIONS:
        con.executescript((ROOT / m).read_text(encoding="utf-8"))
    return con


COLS = ("id,name,type,group_key,day_mask,start_min,end_min,end_day_offset,"
        "days_label,note,publish_from,publish_to,active,sort_order,status,version")


def mission(**over):
    row = dict(id=str(uuid.uuid4()), name="평일런치", type="regular", group_key="lunch",
               day_mask=62, start_min=655, end_min=779, end_day_offset=0,
               days_label=None, note=None, publish_from=None, publish_to=None,
               active=1, sort_order=0, status="published", version=1)
    row.update(over)
    return row


def insert(con, row):
    con.execute("INSERT INTO missions (%s) VALUES (%s)" % (COLS, ",".join("?" * 16)),
                [row[c] for c in COLS.split(",")])


def rejects(con, row, why):
    try:
        insert(con, row)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("거부돼야 하는데 통과함: %s" % why)


def accepts(con, row):
    insert(con, row)


print("=== 마이그레이션 적용 ===")


def t_apply():
    con = fresh()
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for t in ("missions", "mission_tiers", "mission_audit", "ops_settings",
              "admin_users", "admin_sessions", "admin_login_attempts",
              "applications", "chat_rate", "chat_logs"):
        assert t in tables, "테이블 누락: %s" % t


check("0001~0007 전부 적용되고 기존 테이블도 남는다", t_apply)


def t_idempotent():
    con = fresh()
    for m in MIGRATIONS:
        con.executescript((ROOT / m).read_text(encoding="utf-8"))  # 2회 적용
    con.execute("SELECT 1 FROM missions")


check("재적용해도 안전하다 (IF NOT EXISTS)", t_idempotent)


def t_no_destructive():
    import re
    bad = []
    for m in ("migrations/0005_missions.sql", "migrations/0006_admin_auth.sql",
              "migrations/0007_ops_settings.sql"):
        sql = (ROOT / m).read_text(encoding="utf-8")
        body = "\n".join(l for l in sql.splitlines() if not l.strip().startswith("--"))
        # 문장 형태만 잡는다. ON DELETE CASCADE / ON UPDATE CASCADE 는 제약 절이라
        # 파괴적 구문이 아니다.
        statements = (
            r"\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b",
            r"\bDELETE\s+FROM\b",
            r"\bUPDATE\s+\w+\s+SET\b",
            r"\bINSERT\s+(OR\s+\w+\s+)?INTO\b",
            r"\bALTER\s+TABLE\b",
            r"\bREPLACE\s+INTO\b",
        )
        for kw in statements:
            if re.search(kw, body, re.I):
                bad.append("%s: %s" % (m, kw))
    assert not bad, "파괴적/데이터 구문 발견: %s" % bad


check("파괴적 구문·INSERT 가 없다 (preview/prod 공유 DB 안전)", t_no_destructive)

print("\n=== missions CHECK 제약 ===")


def t_time():
    con = fresh()
    accepts(con, mission())
    rejects(con, mission(start_min=800, end_min=700, end_day_offset=0), "종료<시작 (당일)")
    rejects(con, mission(start_min=700, end_min=700, end_day_offset=0), "종료==시작")
    rejects(con, mission(start_min=600, end_min=800, end_day_offset=1), "익일인데 종료>시작")
    rejects(con, mission(start_min=600, end_min=600, end_day_offset=1), "익일인데 종료==시작")
    accepts(con, mission(group_key="n1", start_min=1290, end_min=90, end_day_offset=1))


check("시간 역전 차단 · 자정 경과 허용", t_time)


def t_pair():
    con = fresh()
    rejects(con, mission(start_min=655, end_min=None), "시작만 있음")
    rejects(con, mission(start_min=None, end_min=779), "종료만 있음")
    accepts(con, mission(group_key="w", day_mask=0, start_min=None, end_min=None))


check("시작·종료는 함께 있거나 함께 없다", t_pair)


def t_offset_needs_time():
    con = fresh()
    rejects(con, mission(day_mask=0, start_min=None, end_min=None, end_day_offset=1),
            "시간 없는데 익일 종료")


check("시간 무관 미션에는 익일 종료 불가", t_offset_needs_time)


def t_timed_needs_day():
    con = fresh()
    rejects(con, mission(day_mask=0), "시간 있는데 요일 없음")


check("시간 지정 미션은 요일 필수", t_timed_needs_day)


def t_ranges():
    con = fresh()
    rejects(con, mission(start_min=-1, end_min=100), "시작 음수")
    rejects(con, mission(start_min=100, end_min=1440), "종료 1440")
    rejects(con, mission(day_mask=128), "요일 마스크 초과")
    rejects(con, mission(day_mask=-1), "요일 마스크 음수")
    rejects(con, mission(end_day_offset=2), "offset 2")
    rejects(con, mission(sort_order=-1), "정렬 음수")
    rejects(con, mission(version=0), "version 0")


check("수치 범위 제약", t_ranges)


def t_enums():
    con = fresh()
    rejects(con, mission(type="bogus"), "잘못된 유형")
    rejects(con, mission(status="bogus"), "잘못된 상태")
    rejects(con, mission(active=2), "active 2")
    for t in ("regular", "weekly", "adhoc", "night", "notice"):
        accepts(con, mission(group_key="g-" + t, type=t))


check("유형 5종 · 상태 4종만 허용", t_enums)


def t_text():
    con = fresh()
    rejects(con, mission(name="   "), "공백 미션명")
    rejects(con, mission(name="가" * 41), "미션명 41자")
    rejects(con, mission(note="가" * 201), "안내문구 201자")
    accepts(con, mission(note="가" * 200))


check("문자열 길이 제약", t_text)


def t_publish_order():
    con = fresh()
    rejects(con, mission(publish_from="2026-08-10T00:00:00Z", publish_to="2026-08-01T00:00:00Z"),
            "게시 종료 < 시작")
    accepts(con, mission(publish_from="2026-08-01T00:00:00Z", publish_to="2026-08-10T00:00:00Z"))
    accepts(con, mission(group_key="p2", publish_from=None, publish_to="2026-08-10T00:00:00Z"))


check("게시 기간 순서 제약", t_publish_order)

print("\n=== UNIQUE 제약 ===")


def t_variant_unique():
    con = fresh()
    accepts(con, mission(group_key="lunch"))
    rejects(con, mission(group_key="lunch"), "동일 변형 중복")
    # 요일이 다르면 허용
    accepts(con, mission(group_key="lunch", day_mask=65, start_min=840, end_min=1014))
    # archived 는 예외 — 이력 보존
    con.execute("UPDATE missions SET status='archived' WHERE group_key='lunch' AND day_mask=62")
    accepts(con, mission(group_key="lunch"))


check("같은 묶음·요일·시간의 중복 등록 차단 (archived 는 예외)", t_variant_unique)


def t_tier_unique():
    con = fresh()
    row = mission()
    accepts(con, row)
    mid = row["id"]

    def tier(slot, count, amount=1000):
        con.execute("INSERT INTO mission_tiers (id,mission_id,target_count,reward_amount,sort_order)"
                    " VALUES (?,?,?,?,?)", (str(uuid.uuid4()), mid, count, amount, slot))

    for i in range(4):
        tier(i, 10 + i)
    try:
        tier(0, 99)
        raise AssertionError("같은 슬롯 중복이 통과함")
    except sqlite3.IntegrityError:
        pass
    try:
        tier(3, 10)
        raise AssertionError("같은 목표 건수 중복이 통과함")
    except sqlite3.IntegrityError:
        pass
    n = con.execute("SELECT COUNT(*) FROM mission_tiers WHERE mission_id=?", (mid,)).fetchone()[0]
    assert n == 4, "티어 4개여야 하는데 %d" % n


check("보상 티어 최대 4단 · 슬롯/건수 중복 차단", t_tier_unique)


def t_tier_checks():
    con = fresh()
    row = mission()
    accepts(con, row)
    mid = row["id"]

    def bad(count, amount, slot, why):
        try:
            con.execute("INSERT INTO mission_tiers (id,mission_id,target_count,reward_amount,sort_order)"
                        " VALUES (?,?,?,?,?)", (str(uuid.uuid4()), mid, count, amount, slot))
        except sqlite3.IntegrityError:
            return
        raise AssertionError("거부돼야 함: %s" % why)

    bad(0, 1000, 0, "목표 건수 0")
    bad(-5, 1000, 0, "목표 건수 음수")
    bad(10, -1, 0, "보상 음수")
    bad(10, 1000, 4, "슬롯 4 (5단째)")
    bad(10, 1000, -1, "슬롯 음수")


check("티어 음수·0건·5단 차단", t_tier_checks)


def t_admin_unique():
    con = fresh()
    con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt) VALUES ('u1','Admin','h','s')")
    try:
        con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt) VALUES ('u2','admin','h','s')")
        raise AssertionError("대소문자만 다른 아이디가 통과함")
    except sqlite3.IntegrityError:
        pass
    try:
        con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt,pw_iterations)"
                    " VALUES ('u3','weak','h','s',1000)")
        raise AssertionError("반복 횟수 1000 이 통과함")
    except sqlite3.IntegrityError:
        pass


check("관리자 아이디 대소문자 무시 유일 · PBKDF2 반복 하한", t_admin_unique)


def t_session_hash_len():
    con = fresh()
    con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt) VALUES ('u1','admin','h','s')")
    con.execute("INSERT INTO admin_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
                ("a" * 64, "u1", "2026-08-03T00:00:00Z"))
    try:
        con.execute("INSERT INTO admin_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
                    ("short", "u1", "2026-08-03T00:00:00Z"))
        raise AssertionError("64자 아닌 토큰 해시가 통과함")
    except sqlite3.IntegrityError:
        pass


check("세션 토큰은 SHA-256 해시 길이(64)만 허용", t_session_hash_len)

print("\n=== FOREIGN KEY 동작 ===")


def t_fk():
    con = fresh()
    try:
        con.execute("INSERT INTO mission_tiers (id,mission_id,target_count,reward_amount,sort_order)"
                    " VALUES ('t','없는미션',10,1000,0)")
        raise AssertionError("존재하지 않는 미션에 티어가 붙음")
    except sqlite3.IntegrityError:
        pass

    row = mission()
    accepts(con, row)
    mid = row["id"]
    con.execute("INSERT INTO mission_tiers (id,mission_id,target_count,reward_amount,sort_order)"
                " VALUES (?,?,?,?,?)", ("t1", mid, 10, 1000, 0))
    con.execute("INSERT INTO mission_audit (id,mission_id,action,actor) VALUES ('a1',?,'create','kim')", (mid,))
    con.execute("DELETE FROM missions WHERE id=?", (mid,))
    assert con.execute("SELECT COUNT(*) FROM mission_tiers").fetchone()[0] == 0, "티어가 CASCADE 되지 않음"
    assert con.execute("SELECT COUNT(*) FROM mission_audit").fetchone()[0] == 1, \
        "감사 로그가 함께 지워짐 — FK 를 걸지 않은 설계 의도 위반"


check("티어는 CASCADE, 감사 로그는 남는다", t_fk)


def t_audit_checks():
    con = fresh()
    try:
        con.execute("INSERT INTO mission_audit (id,mission_id,action,actor) VALUES ('a','m','bogus','kim')")
        raise AssertionError("잘못된 action 이 통과함")
    except sqlite3.IntegrityError:
        pass
    try:
        con.execute("INSERT INTO mission_audit (id,mission_id,action,actor) VALUES ('a','m','create','  ')")
        raise AssertionError("빈 actor 가 통과함")
    except sqlite3.IntegrityError:
        pass


check("감사 로그 action 화이트리스트 · actor 필수", t_audit_checks)


print("\n=== ops_settings (4-2B1) ===")


def t_ops_settings():
    con = fresh()
    # 기본은 '행 없음' = dynamic. 마이그레이션이 아무것도 심지 않는지 확인.
    n = con.execute("SELECT COUNT(*) FROM ops_settings").fetchone()[0]
    assert n == 0, "마이그레이션이 초기 데이터를 심었다 (%d행)" % n
    con.execute("INSERT INTO ops_settings (key,value,updated_by) VALUES ('mission_source','static','kim')")
    v = con.execute("SELECT value FROM ops_settings WHERE key='mission_source'").fetchone()[0]
    assert v == "static"
    try:
        con.execute("INSERT INTO ops_settings (key,value) VALUES ('mission_source','dynamic')")
        raise AssertionError("같은 키가 두 번 들어감")
    except sqlite3.IntegrityError:
        pass
    try:
        con.execute("INSERT INTO ops_settings (key,value) VALUES ('   ','x')")
        raise AssertionError("공백 키가 통과함")
    except sqlite3.IntegrityError:
        pass
    try:
        con.execute("INSERT INTO ops_settings (key,value) VALUES ('k','x'||replace(hex(zeroblob(120)),'0','y'))")
        raise AssertionError("200자 초과 값이 통과함")
    except sqlite3.IntegrityError:
        pass


check("ops_settings — 키 유일 · 초기 데이터 0건 · 길이 제약", t_ops_settings)


def t_ops_upsert():
    con = fresh()
    for v in ("static", "dynamic", "static"):
        con.execute("INSERT INTO ops_settings (key,value,updated_at,updated_by) VALUES ('mission_source',?,?,?)"
                    " ON CONFLICT(key) DO UPDATE SET value=excluded.value,"
                    " updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                    (v, "2026-08-03T00:00:00Z", "kim"))
    row = con.execute("SELECT value, updated_by FROM ops_settings WHERE key='mission_source'").fetchone()
    assert row == ("static", "kim"), row
    assert con.execute("SELECT COUNT(*) FROM ops_settings").fetchone()[0] == 1


check("ops_settings — UPSERT 로 토글해도 1행 유지", t_ops_upsert)

print("\n=== admin_login_attempts (IP+아이디 조합) ===")


def t_login_attempts_key():
    con = fresh()
    ins = ("INSERT INTO admin_login_attempts (ip,username,window_start,count) VALUES (?,?,?,?)")
    con.execute(ins, ("1.2.3.4", "admin", 100, 1))
    # 같은 IP + 다른 아이디는 별개 행 (한 사람 오타가 사무실 전체를 잠그지 않는다)
    con.execute(ins, ("1.2.3.4", "manager", 100, 1))
    # 다른 IP + 같은 아이디도 별개 행
    con.execute(ins, ("5.6.7.8", "admin", 100, 1))
    try:
        con.execute(ins, ("1.2.3.4", "admin", 200, 1))
        raise AssertionError("(ip,username) 중복이 통과함")
    except sqlite3.IntegrityError:
        pass
    # IP 단위 합산 = 계정 열거 탐지
    total = con.execute("SELECT SUM(count) FROM admin_login_attempts WHERE ip=?", ("1.2.3.4",)).fetchone()[0]
    assert total == 2, "IP 합산이 %s" % total


check("(ip, username) 복합 키 — IP 합산으로 계정 열거도 탐지 가능", t_login_attempts_key)


def t_login_attempts_checks():
    con = fresh()
    ins = ("INSERT INTO admin_login_attempts (ip,username,window_start,count) VALUES (?,?,?,?)")
    for args, why in [
        (("1.2.3.4", "Admin", 100, 1), "대문자 아이디(정규화 안 됨)"),
        (("1.2.3.4", "admin", -1, 1), "음수 윈도"),
        (("1.2.3.4", "admin", 100, -1), "음수 횟수"),
        (("   ", "admin", 100, 1), "공백 IP"),
    ]:
        try:
            con.execute(ins, args)
            raise AssertionError("거부돼야 함: %s" % why)
        except sqlite3.IntegrityError:
            pass


check("아이디 소문자 정규화 강제 · 음수 차단", t_login_attempts_checks)


def t_login_attempts_index():
    con = fresh()
    idx = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admin_login_attempts'")}
    assert "idx_admin_login_attempts_ip" in idx, idx
    assert "idx_admin_login_attempts_window" in idx, idx
    plan = con.execute("EXPLAIN QUERY PLAN SELECT SUM(count) FROM admin_login_attempts"
                       " WHERE ip=? AND window_start>=?", ("1.2.3.4", 0)).fetchall()
    assert any("idx_admin_login_attempts_ip" in str(r) or "USING" in str(r) for r in plan), plan


check("IP 합산·윈도 정리용 인덱스 존재", t_login_attempts_index)

print("\n=== admin_sessions 만료·FK ===")


def t_sessions_fk_cascade():
    con = fresh()
    con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt) VALUES ('u1','admin','h','s')")
    con.execute("INSERT INTO admin_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
                ("a" * 64, "u1", "2026-08-03T00:00:00Z"))
    try:
        con.execute("INSERT INTO admin_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
                    ("b" * 64, "없는유저", "2026-08-03T00:00:00Z"))
        raise AssertionError("존재하지 않는 사용자에 세션이 붙음")
    except sqlite3.IntegrityError:
        pass
    con.execute("DELETE FROM admin_users WHERE id='u1'")
    n = con.execute("SELECT COUNT(*) FROM admin_sessions").fetchone()[0]
    assert n == 0, "계정 삭제 시 세션이 CASCADE 되지 않음 (%d행 잔존)" % n


check("계정 삭제 시 세션 CASCADE · 없는 사용자 세션 차단", t_sessions_fk_cascade)


def t_sessions_indexes():
    con = fresh()
    idx = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admin_sessions'")}
    for want in ("idx_admin_sessions_user", "idx_admin_sessions_expiry", "idx_admin_sessions_live"):
        assert want in idx, "%s 없음 (%s)" % (want, idx)
    plan = str(con.execute("EXPLAIN QUERY PLAN SELECT token_hash FROM admin_sessions"
                           " WHERE expires_at < ?", ("2026-08-03T00:00:00Z",)).fetchall())
    assert "idx_admin_sessions_expiry" in plan or "idx_admin_sessions_live" in plan, plan


check("만료 인덱스 3종 존재 · 만료 스윕이 인덱스를 탄다", t_sessions_indexes)


def t_sessions_expiry_required():
    con = fresh()
    con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt) VALUES ('u1','admin','h','s')")
    try:
        con.execute("INSERT INTO admin_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
                    ("c" * 64, "u1", "  "))
        raise AssertionError("빈 만료시각이 통과함")
    except sqlite3.IntegrityError:
        pass


check("만료 시각 필수", t_sessions_expiry_required)

print("\n=== 공개 조회 쿼리 (=/mission-data 필터) ===")


def t_public_query():
    con = fresh()
    now = "2026-08-03T12:00:00.000Z"
    accepts(con, mission(group_key="a", status="published", active=1))
    accepts(con, mission(group_key="b", status="draft"))
    accepts(con, mission(group_key="c", status="ended"))
    accepts(con, mission(group_key="d", active=0))
    accepts(con, mission(group_key="e", publish_from="2026-09-01T00:00:00Z"))
    accepts(con, mission(group_key="f", publish_to="2026-08-01T00:00:00Z"))
    accepts(con, mission(group_key="g", publish_from="2026-08-01T00:00:00Z",
                         publish_to="2026-08-31T00:00:00Z"))
    rows = con.execute(
        "SELECT group_key FROM missions WHERE status='published' AND active=1"
        " AND (publish_from IS NULL OR publish_from <= ?)"
        " AND (publish_to IS NULL OR publish_to >= ?) ORDER BY sort_order, id", (now, now)).fetchall()
    got = sorted(r[0] for r in rows)
    assert got == ["a", "g"], "노출 대상이 %s (기대 ['a','g'])" % got


check("초안·종료·비활성·기간 밖은 공개 조회에서 빠진다", t_public_query)


def t_optimistic_lock():
    con = fresh()
    row = mission()
    accepts(con, row)
    mid = row["id"]
    cur = con.execute("UPDATE missions SET name='변경1', version=version+1 WHERE id=? AND version=?",
                      (mid, 1))
    assert cur.rowcount == 1, "첫 갱신이 실패함"
    cur = con.execute("UPDATE missions SET name='변경2', version=version+1 WHERE id=? AND version=?",
                      (mid, 1))
    assert cur.rowcount == 0, "낡은 version 으로 덮어쓰기가 성공함 (충돌 감지 실패)"
    v = con.execute("SELECT version, name FROM missions WHERE id=?", (mid,)).fetchone()
    assert v[0] == 2 and v[1] == "변경1", "상태가 %s" % (v,)


check("낙관적 잠금 — 낡은 version 갱신은 0행", t_optimistic_lock)

print("\n=== 4-2C 인증 SQL (admin-auth.server.ts 에서 그대로 추출) ===")

# 여기부터는 **출하되는 SQL 원문**을 TS 소스에서 뽑아 실제 엔진에 돌린다.
# 테스트용으로 옮겨 적으면 둘이 갈라진 것을 아무도 모르게 되므로 복사하지 않는다.
AUTH_TS = (ROOT / "src/lib/admin-auth.server.ts").read_text(encoding="utf-8")


def sql(name):
    m = re.search(r"const %s = `(.*?)`;" % name, AUTH_TS, re.S)
    assert m, "%s 를 admin-auth.server.ts 에서 찾지 못함" % name
    return m.group(1)


def seed_user(con, uid="u1", username="admin", disabled=0):
    con.execute("INSERT INTO admin_users (id,username,pw_hash,pw_salt,role,disabled)"
                " VALUES (?,?,'h','s','admin',?)", (uid, username, disabled))
    return uid


def t_attempt_upsert_window():
    con = fresh()
    up = sql("ATTEMPT_UPSERT")
    w1, w2 = 900000, 900000 + 900000
    for _ in range(3):
        con.execute(up, ("1.2.3.4", "admin", w1, "2026-08-05T00:00:00Z"))
    row = con.execute("SELECT window_start, count FROM admin_login_attempts"
                      " WHERE ip='1.2.3.4' AND username='admin'").fetchone()
    assert row == (w1, 3), "같은 창에서 누적되지 않음: %s" % (row,)
    # 창이 넘어가면 이어 세지 않고 1 로 되돌린다(고정 창)
    con.execute(up, ("1.2.3.4", "admin", w2, "2026-08-05T00:15:00Z"))
    row = con.execute("SELECT window_start, count FROM admin_login_attempts"
                      " WHERE ip='1.2.3.4' AND username='admin'").fetchone()
    assert row == (w2, 1), "창이 바뀌었는데 리셋되지 않음: %s" % (row,)
    assert con.execute("SELECT COUNT(*) FROM admin_login_attempts").fetchone()[0] == 1


check("실패 집계 UPSERT — 같은 창은 누적, 창이 바뀌면 1로 리셋", t_attempt_upsert_window)


def t_attempt_select_layers():
    con = fresh()
    up, sel = sql("ATTEMPT_UPSERT"), sql("ATTEMPT_SELECT")
    w = 900000
    for _ in range(2):
        con.execute(up, ("1.2.3.4", "admin", w, "t"))
    for name in ("manager", "staff", "owner"):
        con.execute(up, ("1.2.3.4", name, w, "t"))
    con.execute(up, ("9.9.9.9", "admin", w, "t"))
    combo, ip_total = con.execute(sel, ("1.2.3.4", "admin", w)).fetchone()
    assert combo == 2, "조합 집계가 %s" % combo
    # 아이디를 바꿔 가며 훑어도 IP 합산에는 그대로 쌓인다. 다른 IP 는 섞이지 않는다.
    assert ip_total == 5, "IP 합산이 %s" % ip_total


check("집계 조회 — 조합과 IP 합산을 한 번에, 다른 IP 는 섞이지 않는다", t_attempt_select_layers)


def t_attempt_select_past_window():
    con = fresh()
    up, sel = sql("ATTEMPT_UPSERT"), sql("ATTEMPT_SELECT")
    old = 900000
    con.execute(up, ("1.2.3.4", "admin", old, "t"))
    combo, ip_total = con.execute(sel, ("1.2.3.4", "admin", old + 900000)).fetchone()
    # 지난 창의 행이 남아 있어도 이번 창에서는 0 이어야 잠금이 저절로 풀린다
    assert (combo, ip_total) == (0, 0), "지난 창이 이번 창에 섞임: %s" % ((combo, ip_total),)


check("집계 조회 — 지난 창은 0 (잠금은 창이 지나면 풀린다)", t_attempt_select_past_window)


def t_attempt_clear_scope():
    con = fresh()
    up, clear, sel = sql("ATTEMPT_UPSERT"), sql("ATTEMPT_CLEAR"), sql("ATTEMPT_SELECT")
    w = 900000
    con.execute(up, ("1.2.3.4", "admin", w, "t"))
    con.execute(up, ("1.2.3.4", "manager", w, "t"))
    con.execute(clear, ("1.2.3.4", "admin"))
    combo, ip_total = con.execute(sel, ("1.2.3.4", "admin", w)).fetchone()
    assert combo == 0, "성공한 조합이 안 지워짐"
    # 성공 로그인이 같은 IP 의 다른 아이디 집계까지 지우면 열거 탐지가 무력해진다
    assert ip_total == 1, "다른 아이디 집계까지 지워짐: %s" % ip_total


check("성공 로그인은 그 조합만 지운다 — 같은 IP 의 다른 집계는 남는다", t_attempt_clear_scope)


def t_session_insert_select():
    con = fresh()
    uid = seed_user(con)
    h = "a" * 64
    con.execute(sql("SESSION_INSERT"), (h, uid, "2026-08-05T00:00:00Z",
                                        "2026-08-05T12:00:00Z", "1.2.3.4", "curl"))
    row = con.execute(sql("SESSION_SELECT"), (h,)).fetchone()
    assert row is not None, "세션 조회가 비었다"
    token_hash, user_id, expires_at, revoked, username, role, disabled = row
    assert (user_id, username, role, revoked, disabled) == (uid, "admin", "admin", 0, 0), row
    # 없는 토큰은 None — 라우트가 401 로 바꾼다
    assert con.execute(sql("SESSION_SELECT"), ("b" * 64,)).fetchone() is None


check("세션 INSERT/SELECT — 계정 정보를 조인해 한 번에 가져온다", t_session_insert_select)


def t_session_select_needs_user():
    con = fresh()
    # 계정이 지워지면 CASCADE 로 세션도 사라진다(0006). 조인이 고아 세션을
    # 되살리지 못하는지 함께 확인한다.
    uid = seed_user(con)
    h = "c" * 64
    con.execute(sql("SESSION_INSERT"), (h, uid, "t", "2026-08-05T12:00:00Z", None, None))
    con.execute("DELETE FROM admin_users WHERE id=?", (uid,))
    assert con.execute(sql("SESSION_SELECT"), (h,)).fetchone() is None


check("계정이 사라지면 세션 조회도 비어야 한다", t_session_select_needs_user)


def t_session_revoke_and_sweep():
    con = fresh()
    uid = seed_user(con)
    live, dead = "d" * 64, "e" * 64
    ins = sql("SESSION_INSERT")
    con.execute(ins, (live, uid, "t", "2026-08-05T12:00:00Z", None, None))
    con.execute(ins, (dead, uid, "t", "2026-08-04T12:00:00Z", None, None))
    con.execute(sql("SESSION_REVOKE"), (live,))
    assert con.execute("SELECT revoked FROM admin_sessions WHERE token_hash=?", (live,)).fetchone()[0] == 1
    # 회수는 행을 지우지 않는다 — 만료 스윕까지 흔적이 남는다
    cur = con.execute(sql("SESSION_SWEEP"), ("2026-08-05T00:00:00Z",))
    assert cur.rowcount == 1, "만료 스윕이 %s행" % cur.rowcount
    left = {r[0] for r in con.execute("SELECT token_hash FROM admin_sessions")}
    assert left == {live}, left


check("회수는 행을 남기고, 만료 스윕만 지운다", t_session_revoke_and_sweep)


def t_session_renew():
    con = fresh()
    uid = seed_user(con)
    h = "f" * 64
    con.execute(sql("SESSION_INSERT"), (h, uid, "t", "2026-08-05T12:00:00Z", None, None))
    cur = con.execute(sql("SESSION_RENEW"), (h, "2026-08-06T00:00:00Z"))
    assert cur.rowcount == 1
    con.execute(sql("SESSION_REVOKE"), (h,))
    # 회수된 세션은 연장되지 않는다 — 연장이 회수를 되돌리면 안 된다
    cur = con.execute(sql("SESSION_RENEW"), (h, "2026-08-07T00:00:00Z"))
    assert cur.rowcount == 0, "회수된 세션이 연장됨"


check("연장은 살아 있는 세션에만 — 회수를 되돌리지 못한다", t_session_renew)


def t_user_insert_and_count():
    con = fresh()
    assert con.execute(sql("USER_COUNT")).fetchone()[0] == 0, "마이그레이션에 계정이 심어져 있다"
    con.execute(sql("USER_INSERT"), ("u1", "admin", "h", "s", 210000, "admin",
                                     "2026-08-05T00:00:00Z"))
    assert con.execute(sql("USER_COUNT")).fetchone()[0] == 1
    # 부트스트랩은 계정이 0개일 때만 도는데, 대소문자만 바꾼 아이디도 막혀야
    # 두 번째 계정이 우회로 들어오지 못한다
    try:
        con.execute(sql("USER_INSERT"), ("u2", "ADMIN", "h", "s", 210000, "admin", "t"))
        raise AssertionError("대소문자만 다른 아이디가 통과함")
    except sqlite3.IntegrityError:
        pass


check("USER_INSERT/USER_COUNT — 초기 계정 0건 · 아이디 대소문자 무시 유일성", t_user_insert_and_count)


def t_user_select_lower():
    con = fresh()
    con.execute(sql("USER_INSERT"), ("u1", "admin", "h", "s", 210000, "admin", "t"))
    # 로그인은 normalizeUsername 으로 소문자를 넘기지만, 조회 SQL 자체도
    # lower() 로 맞춰 두 경로가 갈라지지 않게 한다
    row = con.execute(sql("USER_SELECT"), ("admin",)).fetchone()
    assert row is not None and row[1] == "admin", row
    assert con.execute(sql("USER_SELECT"), ("nobody",)).fetchone() is None


check("USER_SELECT — lower(username) 으로 찾는다", t_user_select_lower)


def t_touch_login():
    con = fresh()
    con.execute(sql("USER_INSERT"), ("u1", "admin", "h", "s", 210000, "admin", "t"))
    con.execute(sql("USER_TOUCH_LOGIN"), ("u1", "2026-08-05T09:00:00Z"))
    v = con.execute("SELECT last_login_at FROM admin_users WHERE id='u1'").fetchone()[0]
    assert v == "2026-08-05T09:00:00Z", v


check("마지막 로그인 시각 기록", t_touch_login)


print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
