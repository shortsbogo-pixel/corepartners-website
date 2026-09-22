/* 관리자 · 이번 주 미션 업데이트 편집기
   - 저장된 미션 조건(또는 기본값)을 표로 보여 주고 수정하게 한다.
   - "AI로 배너 읽기": 선택한 배너를 줄여서 /api/promo-extract 로 보내고, 돌아온 초안으로 표를 채운다.
   - 저장: 표 내용을 missions_json 으로 담아 /api/promo-upload 로 보낸다. 오류는 화면에 바로 보여 준다.
   관리자 입력값은 DOM 에 textContent / value 로만 넣는다(innerHTML 로 넣지 않는다). */
(function () {
  "use strict";
  var dataEl = document.getElementById("mcData");
  var form = document.getElementById("mcForm");
  if (!dataEl || !form) return;
  var DATA = JSON.parse(dataEl.textContent || "{}");
  var state = JSON.parse(JSON.stringify(DATA.config));
  var aiMarked = false;

  var DAYS = [1, 2, 3, 4, 5, 6, 0];
  var DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
  var TITLES = { lunch: "① 평일런치", postlunch: "② 포스트런치", owl: "③ 올빼미(야간)" };

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs)
      for (var k in attrs) {
        if (k === "text") e.textContent = attrs[k];
        else if (k === "cls") e.className = attrs[k];
        else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    (kids || []).forEach(function (c) {
      if (c) e.appendChild(c);
    });
    return e;
  }
  function won(n) {
    return Number(n || 0).toLocaleString("en-US") + "원";
  }
  function man(n) {
    n = Number(n || 0);
    var m = Math.floor(n / 10000),
      r = n % 10000;
    if (!m) return won(n);
    if (!r) return m + "만원";
    if (r % 1000 === 0) return m + "만 " + r / 1000 + "천원";
    return m + "만 " + r.toLocaleString("en-US") + "원";
  }
  function num(v) {
    var x = Number(String(v).replace(/[,\s원건]/g, ""));
    return isFinite(x) ? x : 0;
  }
  function missionMax(m) {
    if (!m.enabled) return 0;
    return m.groups.reduce(function (a, g) {
      return a + num(g.pay) * (m.basis === "daily" ? g.days.length : 1);
    }, 0);
  }
  function weeklyMax() {
    var t = state.weekly.tiers;
    return t.length ? num(t[t.length - 1].total) : 0;
  }

  function numInput(obj, key, w, onch) {
    return el("input", {
      type: "text",
      inputmode: "numeric",
      value: String(obj[key]),
      style: "width:" + w + "px",
      oninput: function (e) {
        obj[key] = e.target.value;
        if (onch) onch();
        refreshTotals();
      },
    });
  }

  var totalsEls = {};
  function refreshTotals() {
    ["lunch", "postlunch", "owl"].forEach(function (k) {
      if (totalsEls[k])
        totalsEls[k].textContent = "최대 " + man(missionMax(state[k])) + " (자동 계산)";
    });
    if (totalsEls.weekly)
      totalsEls.weekly.textContent = "최대 " + man(weeklyMax()) + " (마지막 단계 누적 금액)";
    var sum =
      missionMax(state.lunch) + missionMax(state.postlunch) + missionMax(state.owl) + weeklyMax();
    if (totalsEls.total)
      totalsEls.total.textContent =
        "주간 미션 최대 합계: " + man(sum) + " — 배너의 합계와 같은지 확인하세요";
  }

  function timedBlock(k) {
    var m = state[k];
    var box = el("div", { cls: "mc-block" });
    var head = el("div", { cls: "mc-h" }, [
      el("label", {}, [
        el("input", {
          type: "checkbox",
          onchange: function (e) {
            m.enabled = e.target.checked;
            render();
          },
        }),
        el("b", { text: " " + TITLES[k] }),
      ]),
      (function () {
        var s = el(
          "select",
          {
            onchange: function (e) {
              m.basis = e.target.value;
              refreshTotals();
            },
          },
          [
            el("option", { value: "daily", text: "요일마다 개별 지급" }),
            el("option", { value: "sum", text: "요일 묶음 합산 지급" }),
          ],
        );
        s.value = m.basis;
        return s;
      })(),
    ]);
    head.querySelector("input").checked = m.enabled;
    box.appendChild(head);
    if (!m.enabled) {
      box.appendChild(el("p", { cls: "c", text: "이번 주에는 게시하지 않습니다." }));
      return box;
    }
    var tb = el("table", { cls: "mc-t" }, [
      el(
        "tr",
        {},
        ["요일", "시작", "종료", "건수", "금액(원)", ""].map(function (h) {
          return el("th", { text: h });
        }),
      ),
    ]);
    m.groups.forEach(function (g, gi) {
      var dayCell = el("td", { cls: "mc-days" });
      DAYS.forEach(function (d) {
        var cb = el("input", {
          type: "checkbox",
          onchange: function (e) {
            if (e.target.checked) {
              if (g.days.indexOf(d) < 0) g.days.push(d);
            } else
              g.days = g.days.filter(function (x) {
                return x !== d;
              });
            refreshTotals();
          },
        });
        cb.checked = g.days.indexOf(d) >= 0;
        dayCell.appendChild(el("label", {}, [cb, document.createTextNode(DAY_NAMES[d])]));
      });
      tb.appendChild(
        el("tr", {}, [
          dayCell,
          el("td", {}, [
            el("input", {
              type: "time",
              value: g.from,
              oninput: function (e) {
                g.from = e.target.value;
              },
            }),
          ]),
          el("td", {}, [
            el("input", {
              type: "time",
              value: g.to,
              oninput: function (e) {
                g.to = e.target.value;
              },
            }),
          ]),
          el("td", {}, [numInput(g, "count", 56)]),
          el("td", {}, [numInput(g, "pay", 84)]),
          el("td", {}, [
            el("button", {
              type: "button",
              cls: "mc-x",
              text: "삭제",
              onclick: function () {
                m.groups.splice(gi, 1);
                render();
              },
            }),
          ]),
        ]),
      );
    });
    box.appendChild(tb);
    var foot = el("div", { cls: "mc-f" }, [
      el("button", {
        type: "button",
        cls: "mc-add",
        text: "+ 줄 추가",
        onclick: function () {
          var last = m.groups[m.groups.length - 1] || {
            from: "13:00",
            to: "16:54",
            count: 10,
            pay: 10000,
          };
          m.groups.push({
            days: [],
            from: last.from,
            to: last.to,
            count: last.count,
            pay: last.pay,
          });
          render();
        },
      }),
      el("label", { cls: "c" }, [
        document.createTextNode("안내 문구 "),
        el("input", {
          type: "text",
          maxlength: "40",
          value: m.note || "",
          placeholder: "예: 앱 공지 확인 후 참여",
          style: "width:190px",
          oninput: function (e) {
            m.note = e.target.value;
          },
        }),
      ]),
    ]);
    totalsEls[k] = el("b", { cls: "mc-sum" });
    foot.appendChild(totalsEls[k]);
    box.appendChild(foot);
    return box;
  }

  function weeklyBlock() {
    var box = el("div", { cls: "mc-block" }, [
      el("div", { cls: "mc-h" }, [el("b", { text: "④ 주간 누적 미션 (수~화 완료 건수)" })]),
    ]);
    var tb = el("table", { cls: "mc-t" }, [
      el(
        "tr",
        {},
        ["단계", "건수", "누적 보상(원)", ""].map(function (h) {
          return el("th", { text: h });
        }),
      ),
    ]);
    state.weekly.tiers.forEach(function (t, i) {
      tb.appendChild(
        el("tr", {}, [
          el("td", { text: String(i + 1) }),
          el("td", {}, [numInput(t, "count", 64)]),
          el("td", {}, [numInput(t, "total", 96)]),
          el("td", {}, [
            el("button", {
              type: "button",
              cls: "mc-x",
              text: "삭제",
              onclick: function () {
                state.weekly.tiers.splice(i, 1);
                render();
              },
            }),
          ]),
        ]),
      );
    });
    box.appendChild(tb);
    totalsEls.weekly = el("b", { cls: "mc-sum" });
    box.appendChild(
      el("div", { cls: "mc-f" }, [
        el("button", {
          type: "button",
          cls: "mc-add",
          text: "+ 단계 추가",
          onclick: function () {
            var l = state.weekly.tiers[state.weekly.tiers.length - 1] || { count: 100, total: 0 };
            state.weekly.tiers.push({ count: num(l.count) + 50, total: num(l.total) + 10000 });
            render();
          },
        }),
        el("span", { cls: "c", text: "금액은 그 단계까지의 누적 보상입니다(배너 표기 그대로)." }),
        totalsEls.weekly,
      ]),
    );
    return box;
  }

  function perksBlock() {
    var p = state.perks,
      r = state.rules;
    var dup = el("input", {
      type: "checkbox",
      onchange: function (e) {
        r.duplicate = e.target.checked;
      },
    });
    dup.checked = !!r.duplicate;
    return el("div", { cls: "mc-block" }, [
      el("div", { cls: "mc-h" }, [el("b", { text: "⑤ 추가 혜택 · 공통 조건" })]),
      el("div", { cls: "mc-grid" }, [
        el("label", {}, [document.createTextNode("친구추천 보상(원) "), numInput(p, "friend", 90)]),
        el("label", {}, [
          document.createTextNode("웰컴: 첫 주 "),
          numInput(p, "welcomeCount", 56),
          document.createTextNode("건 달성 시 "),
          numInput(p, "welcomePay", 84),
          document.createTextNode("원"),
        ]),
        el("label", {}, [
          document.createTextNode("장비지원(오일·패드): "),
          numInput(p, "gearCount", 56),
          document.createTextNode("건 이상"),
        ]),
        el("label", {}, [
          document.createTextNode("거절·취소율 "),
          numInput(r, "cancelRateMax", 44),
          document.createTextNode("% 이하"),
        ]),
        el("label", {}, [dup, document.createTextNode(" 미션 간 중복지급")]),
      ]),
    ]);
  }

  var editor = document.getElementById("mcEditor");
  function render() {
    totalsEls = {};
    editor.textContent = "";
    if (aiMarked)
      editor.appendChild(
        el("p", {
          cls: "mc-ai",
          text: "🤖 AI가 배너에서 읽어 채운 값입니다. 저장 전에 배너와 한 줄씩 대조해 주세요.",
        }),
      );
    ["lunch", "postlunch", "owl"].forEach(function (k) {
      editor.appendChild(timedBlock(k));
    });
    editor.appendChild(weeklyBlock());
    editor.appendChild(perksBlock());
    totalsEls.total = el("p", { cls: "mc-total" });
    editor.appendChild(totalsEls.total);
    editor.classList.toggle("ai", aiMarked);
    refreshTotals();
  }
  render();

  // ── AI로 배너 읽기
  var aiBtn = document.getElementById("mcAi"),
    aiMsg = document.getElementById("mcAiMsg");
  var fileIn = document.getElementById("mcBanner");
  function say(t, bad) {
    aiMsg.textContent = t;
    aiMsg.style.color = bad ? "#f87171" : "#9fe8c4";
  }

  // 사이트 CSP(img-src 'self' data: https:)가 blob: 을 막으므로 data: URL 로 읽는다
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () {
        reject(new Error("read"));
      };
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * s);
          c.height = Math.round(img.naturalHeight * s);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(
            function (b) {
              b ? resolve(b) : reject(new Error("toBlob"));
            },
            "image/jpeg",
            0.9,
          );
        };
        img.onerror = function () {
          reject(new Error("load"));
        };
        img.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    });
  }

  // 수요일 시작 주차: 시작일이 그 달의 몇 번째 수요일인지 (2026-09-23 → 4주차)
  function weekLabel(ymd) {
    var p = ymd.split("-").map(Number);
    return p[0] + "년 " + p[1] + "월 " + Math.ceil(p[2] / 7) + "주차";
  }

  aiBtn.addEventListener("click", function () {
    var f = fileIn.files && fileIn.files[0];
    if (!f) {
      say("먼저 배너 이미지를 선택하세요.", true);
      return;
    }
    aiBtn.disabled = true;
    say("AI가 배너를 읽는 중입니다… (10~30초)");
    shrink(f)
      .then(function (blob) {
        var fd = new FormData();
        fd.append("image", blob, "banner.jpg");
        return fetch(DATA.extractUrl, { method: "POST", body: fd });
      })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) {
          say(
            (j.error || "AI 읽기 실패") +
              (j.errors ? " · " + j.errors.slice(0, 3).join(" / ") : "") +
              " — 표를 직접 수정해 주세요.",
            true,
          );
          return;
        }
        state = j.config;
        aiMarked = true;
        var st = form.querySelector("[name=start]"),
          en = form.querySelector("[name=end]"),
          lb = form.querySelector("[name=label]");
        if (j.period && j.period.start) st.value = j.period.start;
        if (j.period && j.period.end) en.value = j.period.end;
        if (j.period && j.period.start) lb.value = weekLabel(j.period.start);
        document.getElementById("mcConfirm").checked = false;
        render();
        say(
          "채웠습니다. 배너와 대조한 뒤 저장하세요." +
            (j.uncertain && j.uncertain.length ? " 확인 필요: " + j.uncertain.join(" / ") : ""),
        );
      })
      .catch(function () {
        say("AI 읽기 중 오류가 났습니다. 표를 직접 수정해 주세요.", true);
      })
      .then(function () {
        aiBtn.disabled = false;
      });
  });

  // ── 저장
  var saveMsg = document.getElementById("mcSaveMsg");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    document.getElementById("mcJson").value = JSON.stringify(state);
    if (!document.getElementById("mcConfirm").checked) {
      saveMsg.textContent = "배너와 조건을 대조한 뒤 확인란에 체크해 주세요.";
      saveMsg.style.color = "#f87171";
      return;
    }
    var btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    saveMsg.textContent = "저장 중…";
    saveMsg.style.color = "#c5d5ef";
    fetch(form.action, { method: "POST", body: new FormData(form) })
      .then(function (r) {
        if (r.ok && r.url.indexOf("promo=ok") >= 0) {
          location.href = r.url;
          return;
        }
        return r.text().then(function (t) {
          saveMsg.textContent = t;
          saveMsg.style.color = "#f87171";
          btn.disabled = false;
        });
      })
      .catch(function () {
        saveMsg.textContent = "저장 중 오류가 났습니다.";
        saveMsg.style.color = "#f87171";
        btn.disabled = false;
      });
  });
})();
