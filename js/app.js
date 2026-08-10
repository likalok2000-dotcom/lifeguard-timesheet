/**
 * 我的工時 — 以一個返工人角度
 * 開始返工 → 隨時離開 → 即時計人工 → 隨時撳返舊紀錄再計
 */
(function () {
  "use strict";

  const STORAGE_KEY = "lifeguard-me-v2";
  const LEGACY_KEY = "lifeguard-timesheet-v1";
  const AUTH_KEY = "lifeguard-auth-v1";

  const TITLES = {
    today: "今日",
    history: "紀錄",
    pay: "我的錢",
    me: "我",
  };

  /**
   * @typedef {{ name: string, rate: number, phone: string, bossPhone?: string }} Me
   * @typedef {{ id: string, date: string, start: string, end: string, location: string, note: string, rate: number, bonus: number, kind?: string, createdAt: string }} Shift
   * @typedef {{ startISO: string, location: string }} Active
   * @typedef {{ me: Me|null, shifts: Shift[], active: Active|null, sentLog: Record<string, string>, locations: string[] }} State
   * @typedef {{ token: string, username: string }} Auth
   */

  /** @type {State} */
  let state = loadState();
  /** @type {Auth|null} */
  let auth = loadAuth();
  let cloudSyncTimer = null;

  // ---------- Storage + 舊版遷移 ----------
  function defaultState() {
    return {
      me: null,
      shifts: [],
      active: null,
      sentLog: {},
      locations: [],
    };
  }

  function normalizeState(p) {
    const shifts = (Array.isArray(p.shifts) ? p.shifts : []).map((s) => ({
      ...s,
      bonus: Number(s.bonus) || 0,
      kind: s.kind || (s.start && s.end ? "shift" : "bonus"),
      location: s.location || "",
      note: s.note || "",
    }));
    // 由舊紀錄自動收集地址
    const fromShifts = shifts
      .map((s) => (s.location || "").trim())
      .filter(Boolean);
    let locations = Array.isArray(p.locations) ? p.locations.slice() : [];
    fromShifts.forEach((loc) => {
      if (!locations.includes(loc)) locations.push(loc);
    });
    return {
      me: p.me || null,
      shifts,
      active: p.active || null,
      sentLog: p.sentLog && typeof p.sentLog === "object" ? p.sentLog : {},
      locations,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return normalizeState(JSON.parse(raw));
      }
      // 遷移舊多人版資料
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const old = JSON.parse(legacy);
        const staff = Array.isArray(old.staff) ? old.staff : [];
        const first = staff[0] || null;
        const staffId = first?.id;
        const shifts = (Array.isArray(old.shifts) ? old.shifts : [])
          .filter((s) => !staffId || s.staffId === staffId)
          .map((s) => ({
            id: s.id || uid(),
            date: s.date,
            start: s.start,
            end: s.end,
            location: s.location || "",
            note: s.note || "",
            rate: first?.rate ?? 0,
            bonus: Number(s.bonus) || 0,
            kind: s.kind || "shift",
            createdAt: s.createdAt || new Date().toISOString(),
          }));
        const migrated = normalizeState({
          me: first
            ? {
                name: first.name,
                rate: Number(first.rate) || 0,
                phone: first.phone || "",
                bossPhone: "",
              }
            : null,
          shifts,
          active: old.active
            ? {
                startISO: old.active.startISO,
                location: old.active.location || "",
              }
            : null,
          sentLog: {},
          locations: [],
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch {
      /* ignore */
    }
    return defaultState();
  }

  function loadAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      const a = JSON.parse(raw);
      if (a && a.token && a.username) return a;
    } catch {
      /* ignore */
    }
    return null;
  }

  function saveAuth(a) {
    auth = a;
    if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
    else localStorage.removeItem(AUTH_KEY);
    updateCloudUI();
  }

  function apiBase() {
    return typeof window.LIFEGUARD_API === "string"
      ? window.LIFEGUARD_API
      : "";
  }

  function apiUrl(path) {
    return apiBase() + path;
  }

  async function apiFetch(path, options) {
    const opts = options || {};
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {}
    );
    if (auth && auth.token) {
      headers.Authorization = "Bearer " + auth.token;
    }
    const res = await fetch(apiUrl(path), {
      method: opts.method || "GET",
      headers,
      body: opts.body,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || "請求失敗");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    flashAutosave();
    scheduleCloudPush();
  }

  function scheduleCloudPush() {
    if (!auth || !auth.token) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => {
      pushToCloud(true).catch(() => {});
    }, 800);
  }

  async function pushToCloud(silent) {
    if (!auth || !auth.token) return;
    try {
      await apiFetch("/api/data", {
        method: "PUT",
        body: JSON.stringify({
          me: state.me,
          shifts: state.shifts,
          active: state.active,
          sentLog: state.sentLog,
          locations: state.locations,
        }),
      });
      if (!silent) toast("已同步到雲端資料庫");
      const hint = document.getElementById("cloud-status");
      if (hint) {
        hint.textContent =
          "已登入雲端 · 紀錄自動同步 · 換機登入可搵返全部紀錄";
      }
    } catch (e) {
      if (!silent) toast("雲端同步失敗：" + (e.message || e));
    }
  }

  async function pullFromCloud() {
    if (!auth || !auth.token) {
      toast("請先登入");
      return;
    }
    const res = await apiFetch("/api/data");
    if (res && res.data) {
      state = normalizeState(res.data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      fillLocationSelects();
      renderLocationManage();
      showApp();
      toast("已由雲端載入紀錄");
    }
  }

  async function cloudRegister(username, password) {
    const res = await apiFetch("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        me: state.me,
        shifts: state.shifts,
        locations: state.locations,
        sentLog: state.sentLog,
      }),
    });
    saveAuth({ token: res.token, username: res.username });
    if (res.data) {
      // 雲端以剛上傳為準
      state = normalizeState(res.data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    showApp();
    toast("註冊成功 · 紀錄已上雲端");
  }

  async function cloudLogin(username, password) {
    const res = await apiFetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    saveAuth({ token: res.token, username: res.username });
    if (res.data) {
      state = normalizeState(res.data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    fillLocationSelects();
    renderLocationManage();
    showApp();
    toast("登入成功 · 已載入你的雲端紀錄");
  }

  function cloudLogout() {
    saveAuth(null);
    toast("已登出雲端（本機紀錄仍保留）");
  }

  // ---------- 常用返工地址 ----------
  function rememberLocation(loc) {
    const name = String(loc || "").trim();
    if (!name) return;
    if (!Array.isArray(state.locations)) state.locations = [];
    // 移到最前
    state.locations = [
      name,
      ...state.locations.filter((x) => x !== name),
    ].slice(0, 50);
  }

  function fillLocationSelects() {
    const locs = Array.isArray(state.locations) ? state.locations : [];
    document.querySelectorAll(".location-pick").forEach((sel) => {
      const targetId = sel.getAttribute("data-target");
      const input = targetId ? document.getElementById(targetId) : null;
      const current = input ? input.value.trim() : "";
      let html = '<option value="">— 揀常用返工地址 —</option>';
      locs.forEach((loc) => {
        const selAttr = loc === current ? " selected" : "";
        html +=
          '<option value="' +
          escapeHtml(loc) +
          '"' +
          selAttr +
          ">" +
          escapeHtml(loc) +
          "</option>";
      });
      html += '<option value="__new__">＋ 輸入新地址…</option>';
      sel.innerHTML = html;
      if (current && locs.includes(current)) sel.value = current;
      else if (current) sel.value = "__new__";
      else sel.value = "";
    });
  }

  function bindLocationPicks() {
    document.querySelectorAll(".location-pick").forEach((sel) => {
      sel.addEventListener("change", () => {
        const targetId = sel.getAttribute("data-target");
        const input = targetId ? document.getElementById(targetId) : null;
        if (!input) return;
        if (sel.value === "__new__") {
          input.value = "";
          input.focus();
          return;
        }
        if (sel.value) {
          input.value = sel.value;
        }
      });
    });
  }

  function renderLocationManage() {
    const list = document.getElementById("location-manage-list");
    const empty = document.getElementById("location-empty");
    if (!list) return;
    const locs = Array.isArray(state.locations) ? state.locations : [];
    if (!locs.length) {
      list.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");
    list.innerHTML = locs
      .map(
        (loc, i) => `
      <div class="location-row" data-loc-index="${i}">
        <span class="location-row-name">${escapeHtml(loc)}</span>
        <button type="button" class="btn btn-danger-outline btn-sm" data-del-loc="${escapeHtml(
          loc
        )}">移除</button>
      </div>`
      )
      .join("");
  }

  function updateCloudUI() {
    const out = document.getElementById("cloud-logged-out");
    const inn = document.getElementById("cloud-logged-in");
    const label = document.getElementById("cloud-user-label");
    const status = document.getElementById("cloud-status");
    const hint = document.getElementById("autosave-hint");
    if (auth && auth.username) {
      if (out) out.classList.add("hidden");
      if (inn) inn.classList.remove("hidden");
      if (label) label.textContent = auth.username;
      if (status) {
        status.textContent =
          "已登入雲端 · 紀錄自動同步 · 換機登入可搵返全部紀錄";
      }
      if (hint) {
        hint.textContent = "✓ 已自動儲存（本機 + 雲端帳號）";
      }
    } else {
      if (out) out.classList.remove("hidden");
      if (inn) inn.classList.add("hidden");
      if (status) {
        status.textContent =
          "登入後紀錄會同步雲端，換機／清瀏覽器都可登入搵返，唔使手動還原。";
      }
    }
  }

  /** 提示：已自動儲存（唔會無故消失） */
  function flashAutosave() {
    const el = document.getElementById("autosave-hint");
    if (!el) return;
    el.textContent = "✓ 已自動儲存 · 可喺下面睇返以往紀錄";
    el.classList.remove("flash");
    // reflow to restart animation
    void el.offsetWidth;
    el.classList.add("flash");
    clearTimeout(flashAutosave._t);
    flashAutosave._t = setTimeout(() => {
      el.textContent = "✓ 所有紀錄已自動儲存喺呢部手機";
      el.classList.remove("flash");
    }, 2200);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Helpers ----------
  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function monthStr(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function formatDateZh(isoDate) {
    if (!isoDate) return "—";
    const [y, m, day] = isoDate.split("-");
    const wd = new Date(isoDate + "T12:00:00").toLocaleDateString("zh-HK", {
      weekday: "short",
    });
    return `${Number(m)}月${Number(day)}日（${wd}）`;
  }

  function formatDateFull(isoDate) {
    if (!isoDate) return "—";
    const [y, m, day] = isoDate.split("-");
    return `${y}年${Number(m)}月${Number(day)}日`;
  }

  function calcHours(date, start, end) {
    if (!date || !start || !end) return 0;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    let startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;
    if (endMin <= startMin) endMin += 24 * 60;
    return Math.round(((endMin - startMin) / 60) * 100) / 100;
  }

  function calcPay(hours, rate) {
    return Math.round((Number(hours) || 0) * (Number(rate) || 0) * 100) / 100;
  }

  function shiftRate(s) {
    return s.rate != null ? Number(s.rate) : Number(state.me?.rate) || 0;
  }

  /** 判頭額外人工 */
  function shiftBonus(s) {
    return Math.max(0, Number(s.bonus) || 0);
  }

  /** 工時人工 + 判頭額外 */
  function shiftTotalPay(s) {
    const h =
      s.kind === "bonus" || (!s.start && !s.end)
        ? 0
        : calcHours(s.date, s.start, s.end);
    return calcPay(h, shiftRate(s)) + shiftBonus(s);
  }

  function isBonusOnly(s) {
    return s.kind === "bonus" || ((!s.start || !s.end) && shiftBonus(s) > 0);
  }

  function money(n) {
    return (
      "$" +
      (Number(n) || 0).toLocaleString("zh-HK", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })
    );
  }

  function hoursLabel(h) {
    if (!h) return "0 小時";
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    if (mins === 0) return `${whole} 小時`;
    if (whole === 0) return `${mins} 分鐘`;
    return `${whole} 小時 ${mins} 分`;
  }

  function hoursFromMs(ms) {
    return Math.max(0, ms / 3600000);
  }

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function myRate() {
    return Number(state.me?.rate) || 0;
  }

  // ---------- Shell ----------
  function showApp() {
    const hasMe = !!(state.me && state.me.name);
    document.getElementById("onboarding").classList.toggle("hidden", hasMe);
    document.getElementById("main-app").classList.toggle("hidden", !hasMe);
    if (hasMe) {
      updateHeader();
      updateClockUI();
      fillLocationSelects();
      renderLocationManage();
      updateCloudUI();
      renderToday();
      renderHistory();
      renderPay();
      fillProfileForm();
    }
  }

  function updateHeader() {
    const el = document.getElementById("header-me");
    if (el && state.me) {
      el.textContent = `${state.me.name} · 時薪 ${money(state.me.rate)}`;
    }
  }

  // ---------- Onboarding ----------
  function onOnboard(e) {
    e.preventDefault();
    const name = document.getElementById("onboard-name").value.trim();
    const rate = parseFloat(document.getElementById("onboard-rate").value);
    if (!name || isNaN(rate) || rate < 0) {
      toast("請填名字同時薪");
      return;
    }
    state.me = { name, rate, phone: "", bossPhone: "" };
    saveState();
    showApp();
    toast(`你好 ${name}！可以開始返工`);
  }

  // ---------- Live clock ----------
  function tickClock() {
    const now = new Date();
    const timeEl = document.getElementById("live-clock");
    const dateEl = document.getElementById("live-date");
    if (timeEl) {
      timeEl.textContent = [
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
      ].join(":");
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString("zh-HK", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
    if (state.active) {
      updateLiveShift(now);
      renderToday(true);
    }
  }

  function updateLiveShift(now = new Date()) {
    if (!state.active) return;
    const rate = myRate();
    const ms = now - new Date(state.active.startISO);
    const hours = hoursFromMs(ms);
    const pay = calcPay(hours, rate);
    const elapsedEl = document.getElementById("elapsed-display");
    const payEl = document.getElementById("live-pay-display");
    const rateEl = document.getElementById("live-rate-line");
    if (elapsedEl) elapsedEl.textContent = formatElapsed(ms);
    if (payEl) payEl.textContent = money(pay);
    if (rateEl) rateEl.textContent = `時薪 ${money(rate)}/時 · 即時：工時 × 時薪`;
  }

  function updateClockUI() {
    const active = state.active;
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    const statusWrap = document.getElementById("clock-status");
    const idle = document.getElementById("idle-panel");
    const working = document.getElementById("working-panel");
    const main = document.getElementById("clock-main");
    const detail = document.getElementById("active-detail");
    const btnIn = document.getElementById("btn-clock-in");

    if (active) {
      const start = new Date(active.startISO);
      const startStr = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
      text.textContent = "返工中 · 可隨時離開";
      statusWrap?.classList.add("on-duty");
      dot.classList.add("on");
      dot.classList.remove("off");
      idle?.classList.add("hidden");
      working?.classList.remove("hidden");
      main?.classList.add("working");
      if (detail) {
        detail.textContent = `${startStr} 開始${
          active.location ? " · " + active.location : ""
        }`;
      }
      updateLiveShift();
    } else {
      text.textContent = "未開始";
      statusWrap?.classList.remove("on-duty");
      dot.classList.remove("on");
      dot.classList.add("off");
      idle?.classList.remove("hidden");
      working?.classList.add("hidden");
      main?.classList.remove("working");
      if (btnIn) btnIn.disabled = !state.me;
    }
  }

  function clockIn() {
    if (!state.me) {
      toast("請先設定你的資料");
      return;
    }
    if (state.active) {
      toast("而家仲返緊工，請先撳「離開」");
      return;
    }
    const location = document.getElementById("clock-location").value.trim();
    if (location) rememberLocation(location);
    state.active = {
      startISO: new Date().toISOString(),
      location,
    };
    saveState();
    fillLocationSelects();
    updateClockUI();
    renderToday();
    toast(`開始返工 · 時薪 ${money(myRate())} · 即時計人工`);
  }

  function clockOut() {
    if (!state.active) {
      toast("未有進行中時段");
      return;
    }
    const now = new Date();
    const start = new Date(state.active.startISO);
    const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(
      start.getDate()
    )}`;
    let startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    let endTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const ms = now - start;
    if (ms < 60 * 1000 || endTime === startTime) {
      const t = new Date(start.getTime() + 60 * 1000);
      endTime = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }
    const rate = myRate();
    const hours = calcHours(date, startTime, endTime);
    const pay = calcPay(hours, rate);
    state.shifts.push({
      id: uid(),
      date,
      start: startTime,
      end: endTime,
      location: state.active.location || "",
      note: "彈性返工",
      rate,
      bonus: 0,
      kind: "shift",
      createdAt: new Date().toISOString(),
    });
    state.active = null;
    saveState();
    updateClockUI();
    renderToday();
    renderHistory();
    renderPay();
    toast(
      `已自動儲存 · ${hoursLabel(hours)} · 賺到 ${money(pay)}`
    );
  }

  // ---------- 今日 ----------
  function renderToday() {
    const rate = myRate();
    const badge = document.getElementById("today-rate-badge");
    if (badge) badge.textContent = `時薪 ${money(rate)}`;

    const today = todayStr();
    const segments = state.shifts
      .filter((s) => s.date === today)
      .sort((a, b) => {
        const ta = a.start || "99:99";
        const tb = b.start || "99:99";
        return ta.localeCompare(tb);
      });

    let totalH = 0;
    let totalBase = 0;
    let totalBonus = 0;
    const rows = [];
    let n = 0;

    segments.forEach((s) => {
      const r = shiftRate(s);
      const bonus = shiftBonus(s);
      const bonusOnly = isBonusOnly(s);
      const h = bonusOnly ? 0 : calcHours(s.date, s.start, s.end);
      const base = calcPay(h, r);
      const p = base + bonus;
      totalH += h;
      totalBase += base;
      totalBonus += bonus;
      n += 1;
      const loc = s.location ? ` · ${escapeHtml(s.location)}` : "";
      if (bonusOnly) {
        rows.push(`
        <button type="button" class="segment-row" data-shift-id="${s.id}">
          <div class="segment-left">
            <div class="segment-time">判頭額外 <span class="badge-bonus">+${money(bonus)}</span></div>
            <div class="segment-meta">${escapeHtml(s.note || "額外人工")}${loc}</div>
          </div>
          <div class="segment-right">
            <div class="segment-pay">${money(p)}</div>
            <div class="segment-meta">已儲存 · 撳睇</div>
          </div>
        </button>`);
      } else {
        const bonusTxt =
          bonus > 0 ? ` + 額外 ${money(bonus)}` : "";
        rows.push(`
        <button type="button" class="segment-row" data-shift-id="${s.id}">
          <div class="segment-left">
            <div class="segment-time">第 ${n} 段 · ${s.start}–${s.end}${
          bonus > 0 ? ' <span class="badge-bonus">有額外</span>' : ""
        }</div>
            <div class="segment-meta">${hoursLabel(h)} × ${money(r)}${bonusTxt}${loc}</div>
          </div>
          <div class="segment-right">
            <div class="segment-pay">${money(p)}</div>
            <div class="segment-meta">已儲存 · 撳睇</div>
          </div>
        </button>`);
      }
    });

    if (state.active) {
      const ms = Date.now() - new Date(state.active.startISO).getTime();
      const h = hoursFromMs(ms);
      const p = calcPay(h, rate);
      totalH += h;
      totalBase += p;
      const start = new Date(state.active.startISO);
      const startStr = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
      const loc = state.active.location
        ? ` · ${escapeHtml(state.active.location)}`
        : "";
      rows.push(`
        <div class="segment-row live">
          <div class="segment-left">
            <div class="segment-time">進行中 · ${startStr}–而家</div>
            <div class="segment-meta">${formatElapsed(ms)} · 即時計${loc}</div>
          </div>
          <div class="segment-right">
            <div class="segment-hours">${hoursLabel(Math.round(h * 100) / 100)}</div>
            <div class="segment-pay">${money(p)}</div>
          </div>
        </div>`);
    }

    totalH = Math.round(totalH * 100) / 100;
    totalBase = Math.round(totalBase * 100) / 100;
    totalBonus = Math.round(totalBonus * 100) / 100;
    const totalP = Math.round((totalBase + totalBonus) * 100) / 100;

    document.getElementById("today-hours").textContent = hoursLabel(totalH);
    document.getElementById("today-pay").textContent = money(totalP);
    const baseEl = document.getElementById("today-base-pay");
    const bonusEl = document.getElementById("today-bonus-pay");
    if (baseEl) baseEl.textContent = money(totalBase);
    if (bonusEl) bonusEl.textContent = money(totalBonus);
    document.getElementById("today-formula").textContent =
      totalP > 0 || totalH > 0
        ? `時薪 ${money(totalBase)} + 額外 ${money(totalBonus)} = ${money(totalP)}`
        : "工時 × 時薪 + 判頭額外 = 合計";

    const list = document.getElementById("today-segments");
    const empty = document.getElementById("today-empty");
    if (!rows.length) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
    } else {
      empty.classList.add("hidden");
      list.innerHTML = rows.join("");
    }

    // WhatsApp 結算掣
    const waBtn = document.getElementById("btn-wa-today");
    const waStatus = document.getElementById("today-wa-status");
    const hasData = totalP > 0 || totalH > 0 || segments.length > 0;
    if (waBtn) waBtn.disabled = !hasData || !!state.active;
    if (waStatus) {
      if (state.active) {
        waStatus.textContent = "請先撳「離開」完成本段，再結算傳 WhatsApp";
      } else if (!hasData) {
        waStatus.textContent = "今日未有紀錄，返工後可一鍵傳俾判頭";
      } else if (state.sentLog && state.sentLog[today]) {
        const t = new Date(state.sentLog[today]);
        const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        waStatus.innerHTML = `<span class="wa-sent-badge">今日已開過 WhatsApp（${ts}）· 可再傳</span>`;
      } else {
        waStatus.textContent =
          "結算後即刻開 WhatsApp，訊息已寫好，你撳傳送就得";
      }
    }

    // 主頁以往紀錄
    renderHomePast();
  }

  /**
   * 主頁顯示以往自動儲存嘅紀錄（唔包今日）
   * 撳入去可睇明細；刪除只喺詳情入面、有需要先做
   */
  function renderHomePast() {
    const list = document.getElementById("home-past-list");
    const empty = document.getElementById("home-past-empty");
    const badge = document.getElementById("past-count-badge");
    if (!list) return;

    const today = todayStr();
    const byDay = groupByDay(state.shifts.filter((s) => s.date !== today));
    const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
    // 主頁先顯示最近 14 日有紀錄嘅日子
    const show = days.slice(0, 14);

    if (badge) badge.textContent = `${days.length} 日`;

    if (!show.length) {
      list.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");

    list.innerHTML = show
      .map((date) => {
        const segs = byDay.get(date);
        const t = dayTotals(segs);
        const sent =
          state.sentLog && state.sentLog[date]
            ? " · 已傳 WhatsApp"
            : "";
        return `
        <button type="button" class="record-item day-item" data-day="${date}">
          <div class="record-top">
            <div>
              <div class="record-name">${formatDateZh(date)}</div>
              <div class="record-meta">${t.count} 項 · ${hoursLabel(t.hours)}${
          t.bonus > 0 ? " · 額外 " + money(t.bonus) : ""
        }${sent}</div>
            </div>
            <div class="record-hours">${money(t.pay)}</div>
          </div>
          <div class="record-pay">已自動儲存 · 撳入去睇（有需要先刪除）</div>
        </button>`;
      })
      .join("");
  }

  // ---------- WhatsApp 結算傳判頭 ----------
  /** 香港電話 → 國碼數字（WhatsApp wa.me 用） */
  function normalizeWaPhone(raw) {
    if (!raw) return "";
    let d = String(raw).replace(/\D/g, "");
    if (!d) return "";
    // 8 位香港手機 → 852
    if (d.length === 8 && /^[456789]/.test(d)) d = "852" + d;
    // 已有 852
    if (d.startsWith("852") && d.length === 11) return d;
    // 其他國碼原樣（至少 10 位）
    if (d.length >= 10) return d;
    return d;
  }

  /**
   * 產生某日結算 WhatsApp 訊息（純文字，方便判頭做紀錄）
   */
  function buildDayWhatsAppMessage(date) {
    const segs = state.shifts
      .filter((s) => s.date === date)
      .sort((a, b) => {
        const ta = a.start || "99:99";
        const tb = b.start || "99:99";
        return ta.localeCompare(tb);
      });
    const t = dayTotals(segs);
    const name = state.me?.name || "救生員";
    const rate = myRate();
    const lines = [];
    lines.push("🏊 救生員工時結算");
    lines.push("——————————");
    lines.push(`日期：${formatDateFull(date)}`);
    lines.push(`姓名：${name}`);
    lines.push(`時薪：${money(rate)}/時`);
    lines.push("——————————");

    if (!segs.length) {
      lines.push("（當日未有紀錄）");
    } else {
      let i = 0;
      segs.forEach((s) => {
        if (isBonusOnly(s)) {
          lines.push(
            `・判頭額外 ${money(shiftBonus(s))}${
              s.location ? " · " + s.location : ""
            }${s.note ? "（" + s.note + "）" : ""}`
          );
        } else {
          i += 1;
          const h = calcHours(s.date, s.start, s.end);
          const base = calcPay(h, shiftRate(s));
          const bonus = shiftBonus(s);
          let line = `・第${i}段 ${s.start}–${s.end}　${hoursLabel(h)}　時薪人工 ${money(base)}`;
          if (bonus > 0) line += ` + 額外 ${money(bonus)}`;
          if (s.location) line += `\n　位置：${s.location}`;
          if (s.note && s.note !== "彈性返工") line += `\n　備註：${s.note}`;
          lines.push(line);
        }
      });
    }

    lines.push("——————————");
    lines.push(`總工時：${hoursLabel(t.hours)}`);
    lines.push(`時薪人工：${money(t.base)}`);
    lines.push(`判頭額外：${money(t.bonus)}`);
    lines.push(`✅ 當日合計：${money(t.pay)}`);
    lines.push("——————————");
    lines.push("（由「我的工時」App 自動產生，方便雙方做紀錄）");
    return lines.join("\n");
  }

  /**
   * 開 WhatsApp 傳當日結算；可選指定電話，否則用設定嘅判頭號碼
   */
  function sendDayToWhatsApp(date) {
    if (state.active && date === todayStr()) {
      toast("請先離開完成進行中時段");
      return;
    }
    const segs = state.shifts.filter((s) => s.date === date);
    if (!segs.length) {
      toast("呢日未有紀錄可傳");
      return;
    }
    const text = buildDayWhatsAppMessage(date);
    const phone = normalizeWaPhone(state.me?.bossPhone || "");
    const encoded = encodeURIComponent(text);
    // 有判頭號碼 → 直達對話；無 → 開 WhatsApp 自己揀人
    const url = phone
      ? `https://wa.me/${phone}?text=${encoded}`
      : `https://wa.me/?text=${encoded}`;

    // 記低「已結算傳送」時間（做紀錄）
    if (!state.sentLog) state.sentLog = {};
    state.sentLog[date] = new Date().toISOString();
    saveState();
    renderToday();
    if (
      !document.getElementById("day-modal").classList.contains("hidden")
    ) {
      updateDayWaStatus(date);
    }

    // iPhone 用 location 較穩
    window.location.href = url;
    toast(
      phone
        ? "已開 WhatsApp · 請撳傳送"
        : "已開 WhatsApp · 請揀判頭再傳送"
    );
  }

  function updateDayWaStatus(date) {
    const el = document.getElementById("day-wa-status");
    if (!el) return;
    if (state.sentLog && state.sentLog[date]) {
      const t = new Date(state.sentLog[date]);
      el.innerHTML = `<span class="wa-sent-badge">曾開 WhatsApp 傳送（${formatDateZh(
        date
      )} ${pad(t.getHours())}:${pad(t.getMinutes())}）</span>`;
    } else {
      el.textContent = "訊息已預備 · 開 WhatsApp 後撳傳送就得";
    }
  }

  // ---------- 補記 + 判頭額外 ----------
  function updateManualPreview() {
    const date = document.getElementById("manual-date").value || todayStr();
    const start = document.getElementById("manual-start").value;
    const end = document.getElementById("manual-end").value;
    const bonus =
      parseFloat(document.getElementById("manual-bonus").value) || 0;
    const rate = myRate();
    const baseEl = document.getElementById("manual-preview-base");
    const bonusEl = document.getElementById("manual-preview-bonus");
    const payEl = document.getElementById("manual-preview-pay");
    const detailEl = document.getElementById("manual-preview-detail");
    if (bonusEl) bonusEl.textContent = money(Math.max(0, bonus));
    if (!start || !end) {
      if (baseEl) baseEl.textContent = "請填時間";
      if (payEl) payEl.textContent = "—";
      if (detailEl) detailEl.textContent = "工時 × 時薪 + 額外";
      return;
    }
    const h = calcHours(date, start, end);
    if (h <= 0) {
      if (baseEl) baseEl.textContent = "時間無效";
      if (payEl) payEl.textContent = "—";
      return;
    }
    const base = calcPay(h, rate);
    const total = base + Math.max(0, bonus);
    if (baseEl) baseEl.textContent = money(base);
    if (payEl) payEl.textContent = money(total);
    if (detailEl) {
      detailEl.textContent = `${hoursLabel(h)} × ${money(rate)} + 額外 ${money(
        Math.max(0, bonus)
      )} = ${money(total)}`;
    }
  }

  function addManual(e) {
    e.preventDefault();
    if (!state.me) return;
    const date = document.getElementById("manual-date").value;
    const start = document.getElementById("manual-start").value;
    const end = document.getElementById("manual-end").value;
    const location = document.getElementById("manual-location").value.trim();
    const note = document.getElementById("manual-note").value.trim();
    const bonus = Math.max(
      0,
      parseFloat(document.getElementById("manual-bonus").value) || 0
    );
    const h = calcHours(date, start, end);
    if (h <= 0) {
      toast("結束要遲過開始");
      return;
    }
    if (h > 24) {
      toast("單段唔好超過 24 小時");
      return;
    }
    const rate = myRate();
    const base = calcPay(h, rate);
    const pay = base + bonus;
    if (location) rememberLocation(location);
    state.shifts.push({
      id: uid(),
      date,
      start,
      end,
      location,
      note,
      rate,
      bonus,
      kind: "shift",
      createdAt: new Date().toISOString(),
    });
    saveState();
    e.target.reset();
    document.getElementById("manual-date").value = todayStr();
    fillLocationSelects();
    updateManualPreview();
    renderToday();
    renderHistory();
    renderPay();
    toast(
      `已自動儲存 · ${hoursLabel(h)} · 合計 ${money(pay)}${
        bonus > 0 ? "（含額外 " + money(bonus) + "）" : ""
      }`
    );
  }

  /** 只記判頭額外（唔使工時） */
  function addBonusOnly(e) {
    e.preventDefault();
    if (!state.me) return;
    const date = document.getElementById("bonus-date").value;
    const amount = parseFloat(document.getElementById("bonus-amount").value);
    const location = document.getElementById("bonus-location").value.trim();
    const note = document.getElementById("bonus-note").value.trim();
    if (!date || isNaN(amount) || amount <= 0) {
      toast("請填日期同額外金額");
      return;
    }
    if (location) rememberLocation(location);
    state.shifts.push({
      id: uid(),
      date,
      start: "",
      end: "",
      location,
      note: note || "判頭額外人工",
      rate: myRate(),
      bonus: amount,
      kind: "bonus",
      createdAt: new Date().toISOString(),
    });
    saveState();
    e.target.reset();
    document.getElementById("bonus-date").value = todayStr();
    fillLocationSelects();
    renderToday();
    renderHistory();
    renderPay();
    toast(`已自動儲存判頭額外 ${money(amount)}`);
  }

  // ---------- 紀錄（按日，可撳返） ----------
  function shiftsInMonth(ym) {
    return state.shifts
      .filter((s) => !ym || s.date.startsWith(ym))
      .sort((a, b) => {
        const c = b.date.localeCompare(a.date);
        if (c !== 0) return c;
        const ta = a.start || "99:99";
        const tb = b.start || "99:99";
        return tb.localeCompare(ta);
      });
  }

  function groupByDay(shifts) {
    /** @type {Map<string, Shift[]>} */
    const map = new Map();
    shifts.forEach((s) => {
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date).push(s);
    });
    return map;
  }

  function dayTotals(list) {
    let h = 0;
    let base = 0;
    let bonus = 0;
    list.forEach((s) => {
      const hours = isBonusOnly(s) ? 0 : calcHours(s.date, s.start, s.end);
      h += hours;
      base += calcPay(hours, shiftRate(s));
      bonus += shiftBonus(s);
    });
    return {
      hours: Math.round(h * 100) / 100,
      base: Math.round(base * 100) / 100,
      bonus: Math.round(bonus * 100) / 100,
      pay: Math.round((base + bonus) * 100) / 100,
      count: list.length,
    };
  }

  function renderHistory() {
    const ym = document.getElementById("history-month").value;
    const shifts = shiftsInMonth(ym);
    const byDay = groupByDay(shifts);
    let monthH = 0;
    let monthBase = 0;
    let monthBonus = 0;
    shifts.forEach((s) => {
      const h = isBonusOnly(s) ? 0 : calcHours(s.date, s.start, s.end);
      monthH += h;
      monthBase += calcPay(h, shiftRate(s));
      monthBonus += shiftBonus(s);
    });
    monthH = Math.round(monthH * 100) / 100;
    const monthP = Math.round((monthBase + monthBonus) * 100) / 100;
    document.getElementById("history-month-hours").textContent =
      hoursLabel(monthH);
    document.getElementById("history-month-pay").textContent = money(monthP);

    const list = document.getElementById("history-list");
    const empty = document.getElementById("history-empty");
    const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));

    if (!days.length) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    list.innerHTML = days
      .map((date) => {
        const segs = byDay.get(date);
        const t = dayTotals(segs);
        const bonusNote =
          t.bonus > 0 ? ` · 含額外 ${money(t.bonus)}` : "";
        return `
        <button type="button" class="record-item day-item" data-day="${date}">
          <div class="record-top">
            <div>
              <div class="record-name">${formatDateZh(date)}</div>
              <div class="record-meta">${t.count} 項 · ${hoursLabel(t.hours)}${bonusNote}</div>
            </div>
            <div class="record-hours">${money(t.pay)}</div>
          </div>
          <div class="record-pay">已自動儲存 · 時薪 ${money(t.base)} + 額外 ${money(t.bonus)} · 撳入去睇</div>
        </button>`;
      })
      .join("");
  }

  // ---------- 某日明細 modal ----------
  function openDayModal(date) {
    const segs = state.shifts
      .filter((s) => s.date === date)
      .sort((a, b) => {
        const ta = a.start || "99:99";
        const tb = b.start || "99:99";
        return ta.localeCompare(tb);
      });
    const t = dayTotals(segs);
    document.getElementById("day-modal-title").textContent =
      formatDateFull(date);
    document.getElementById("day-modal-hours").textContent = hoursLabel(
      t.hours
    );
    document.getElementById("day-modal-pay").textContent = money(t.pay);
    document.getElementById("day-modal-formula").textContent =
      `時薪 ${money(t.base)} + 額外 ${money(t.bonus)} = ${money(t.pay)}`;
    const dayDateEl = document.getElementById("day-modal-date");
    if (dayDateEl) dayDateEl.value = date;
    updateDayWaStatus(date);
    const waDayBtn = document.getElementById("btn-wa-day");
    if (waDayBtn) {
      waDayBtn.disabled = !segs.length || (state.active && date === todayStr());
    }
    document.getElementById("day-modal-segments").innerHTML = segs
      .map((s, i) => {
        const r = shiftRate(s);
        const bonus = shiftBonus(s);
        const bonusOnly = isBonusOnly(s);
        const h = bonusOnly ? 0 : calcHours(s.date, s.start, s.end);
        const base = calcPay(h, r);
        const p = base + bonus;
        const loc = s.location ? ` · ${escapeHtml(s.location)}` : "";
        const note = s.note ? ` · ${escapeHtml(s.note)}` : "";
        if (bonusOnly) {
          return `
        <button type="button" class="segment-row" data-shift-id="${s.id}">
          <div class="segment-left">
            <div class="segment-time">判頭額外 <span class="badge-bonus">+${money(bonus)}</span></div>
            <div class="segment-meta">${escapeHtml(s.note || "額外人工")}${loc}</div>
          </div>
          <div class="segment-right">
            <div class="segment-pay">${money(p)}</div>
            <div class="segment-meta">改</div>
          </div>
        </button>`;
        }
        return `
        <button type="button" class="segment-row" data-shift-id="${s.id}">
          <div class="segment-left">
            <div class="segment-time">第 ${i + 1} 項 · ${s.start}–${s.end}${
          bonus > 0 ? ' <span class="badge-bonus">有額外</span>' : ""
        }</div>
            <div class="segment-meta">${hoursLabel(h)} × ${money(r)}${
          bonus > 0 ? " + " + money(bonus) : ""
        }${loc}${note}</div>
          </div>
          <div class="segment-right">
            <div class="segment-pay">${money(p)}</div>
            <div class="segment-meta">已儲存 · 撳睇</div>
          </div>
        </button>`;
      })
      .join("");
    document.getElementById("day-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeDayModal() {
    document.getElementById("day-modal").classList.add("hidden");
    document.body.style.overflow = "";
  }

  // ---------- 編輯時段（重新計） ----------
  function openEditModal(id) {
    const s = state.shifts.find((x) => x.id === id);
    if (!s) return;
    document.getElementById("edit-id").value = s.id;
    document.getElementById("edit-date").value = s.date;
    document.getElementById("edit-start").value = s.start || "";
    document.getElementById("edit-end").value = s.end || "";
    document.getElementById("edit-location").value = s.location || "";
    document.getElementById("edit-note").value = s.note || "";
    document.getElementById("edit-bonus").value = shiftBonus(s) || "";
    fillLocationSelects();
    const timeRow = document.getElementById("edit-time-row");
    const startInput = document.getElementById("edit-start");
    const endInput = document.getElementById("edit-end");
    if (isBonusOnly(s)) {
      // 純額外：時間可留空
      if (timeRow) timeRow.style.opacity = "0.55";
      startInput.required = false;
      endInput.required = false;
      document.getElementById("edit-modal-title").textContent =
        "編輯判頭額外 · 重新計";
    } else {
      if (timeRow) timeRow.style.opacity = "1";
      startInput.required = true;
      endInput.required = true;
      document.getElementById("edit-modal-title").textContent =
        "編輯時段 · 重新計人工";
    }
    updateEditPreview();
    document.getElementById("edit-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeEditModal() {
    document.getElementById("edit-modal").classList.add("hidden");
    // 若日 modal 仲開，保持 body hidden
    if (document.getElementById("day-modal").classList.contains("hidden")) {
      document.body.style.overflow = "";
    }
  }

  function updateEditPreview() {
    const date = document.getElementById("edit-date").value;
    const start = document.getElementById("edit-start").value;
    const end = document.getElementById("edit-end").value;
    const bonus =
      Math.max(0, parseFloat(document.getElementById("edit-bonus").value) || 0);
    const rate = myRate();
    const baseEl = document.getElementById("edit-preview-base");
    const bonusEl = document.getElementById("edit-preview-bonus");
    const payEl = document.getElementById("edit-preview-pay");
    const detailEl = document.getElementById("edit-preview-detail");
    if (bonusEl) bonusEl.textContent = money(bonus);

    if (!start && !end) {
      // 純額外
      if (baseEl) baseEl.textContent = money(0);
      if (payEl) payEl.textContent = bonus > 0 ? money(bonus) : "—";
      if (detailEl) {
        detailEl.textContent =
          bonus > 0
            ? `判頭額外 ${money(bonus)}`
            : "可只填額外金額，或填返工時段";
      }
      return;
    }
    const h = calcHours(date, start, end);
    if (h <= 0) {
      if (baseEl) baseEl.textContent = "時間無效";
      if (payEl) payEl.textContent = "—";
      if (detailEl) detailEl.textContent = "請填正確開始／結束時間";
      return;
    }
    const base = calcPay(h, rate);
    const total = base + bonus;
    if (baseEl) baseEl.textContent = money(base);
    if (payEl) payEl.textContent = money(total);
    if (detailEl) {
      detailEl.textContent = `${hoursLabel(h)} × ${money(rate)} + 額外 ${money(
        bonus
      )} = ${money(total)}`;
    }
  }

  function saveEdit(e) {
    e.preventDefault();
    const id = document.getElementById("edit-id").value;
    const idx = state.shifts.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const date = document.getElementById("edit-date").value;
    const start = document.getElementById("edit-start").value;
    const end = document.getElementById("edit-end").value;
    const bonus = Math.max(
      0,
      parseFloat(document.getElementById("edit-bonus").value) || 0
    );
    const rate = myRate();
    const oldDate = state.shifts[idx].date;
    const prevKind = state.shifts[idx].kind;

    // 純額外：唔使時間
    if ((!start && !end) || prevKind === "bonus") {
      if (bonus <= 0 && !start) {
        toast("額外金額要大於 0");
        return;
      }
      if (start && end) {
        const h = calcHours(date, start, end);
        if (h <= 0) {
          toast("結束要遲過開始");
          return;
        }
        const base = calcPay(h, rate);
        state.shifts[idx] = {
          ...state.shifts[idx],
          date,
          start,
          end,
          location: document.getElementById("edit-location").value.trim(),
          note: document.getElementById("edit-note").value.trim(),
          rate,
          bonus,
          kind: "shift",
        };
        saveState();
        closeEditModal();
        renderToday();
        renderHistory();
        renderPay();
        if (!document.getElementById("day-modal").classList.contains("hidden")) {
          openDayModal(date || oldDate);
        }
        toast(`已更新 · 合計 ${money(base + bonus)}`);
        return;
      }
      state.shifts[idx] = {
        ...state.shifts[idx],
        date,
        start: "",
        end: "",
        location: document.getElementById("edit-location").value.trim(),
        note:
          document.getElementById("edit-note").value.trim() || "判頭額外人工",
        rate,
        bonus,
        kind: "bonus",
      };
      saveState();
      closeEditModal();
      renderToday();
      renderHistory();
      renderPay();
      if (!document.getElementById("day-modal").classList.contains("hidden")) {
        openDayModal(date || oldDate);
      }
      toast(`已更新額外 · ${money(bonus)}`);
      return;
    }

    const h = calcHours(date, start, end);
    if (h <= 0) {
      toast("結束要遲過開始");
      return;
    }
    const base = calcPay(h, rate);
    const pay = base + bonus;
    const locEdit = document.getElementById("edit-location").value.trim();
    if (locEdit) rememberLocation(locEdit);
    state.shifts[idx] = {
      ...state.shifts[idx],
      date,
      start,
      end,
      location: locEdit,
      note: document.getElementById("edit-note").value.trim(),
      rate,
      bonus,
      kind: "shift",
    };
    saveState();
    fillLocationSelects();
    closeEditModal();
    renderToday();
    renderHistory();
    renderPay();
    if (!document.getElementById("day-modal").classList.contains("hidden")) {
      openDayModal(date || oldDate);
    }
    toast(`已更新 · ${hoursLabel(h)} · 合計 ${money(pay)}`);
  }

  function deleteShift() {
    const id = document.getElementById("edit-id").value;
    if (
      !confirm(
        "確定要刪除呢段紀錄？\n\n平時紀錄會自動儲存，唔會自己消失。\n只有你確認先會剷除。"
      )
    ) {
      return;
    }
    if (!confirm("再確認一次：真係刪除？（刪除後唔可以復原，除非有備份）")) {
      return;
    }
    const s = state.shifts.find((x) => x.id === id);
    const date = s?.date;
    state.shifts = state.shifts.filter((x) => x.id !== id);
    saveState();
    closeEditModal();
    renderToday();
    renderHistory();
    renderPay();
    if (date && state.shifts.some((x) => x.date === date)) {
      openDayModal(date);
    } else {
      closeDayModal();
    }
    toast("已刪除呢段 · 其他紀錄仍然自動保存");
  }

  // ---------- 我的錢 ----------
  function renderPay() {
    const ym = document.getElementById("pay-month").value;
    const shifts = shiftsInMonth(ym);
    let h = 0;
    let base = 0;
    let bonus = 0;
    const days = new Set();
    shifts.forEach((s) => {
      const hours = isBonusOnly(s) ? 0 : calcHours(s.date, s.start, s.end);
      h += hours;
      base += calcPay(hours, shiftRate(s));
      bonus += shiftBonus(s);
      days.add(s.date);
    });
    h = Math.round(h * 100) / 100;
    base = Math.round(base * 100) / 100;
    bonus = Math.round(bonus * 100) / 100;
    const p = Math.round((base + bonus) * 100) / 100;

    document.getElementById("pay-total").textContent = money(p);
    document.getElementById("pay-hours").textContent = String(h);
    document.getElementById("pay-days").textContent = String(days.size);
    const baseEl = document.getElementById("pay-base");
    const bonusEl = document.getElementById("pay-bonus");
    if (baseEl) baseEl.textContent = money(base);
    if (bonusEl) bonusEl.textContent = money(bonus);
    document.getElementById("pay-period").textContent = ym
      ? `${ym.replace("-", "年")}月 · ${state.me?.name || ""}`
      : `全部 · ${state.me?.name || ""}`;
    document.getElementById("pay-formula").textContent =
      p > 0 || h > 0
        ? `時薪 ${money(base)} + 判頭額外 ${money(bonus)} = ${money(p)}`
        : "工時 × 時薪 + 判頭額外 = 合計";

    const byDay = groupByDay(shifts);
    const dayKeys = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
    const list = document.getElementById("pay-days-list");
    if (!dayKeys.length) {
      list.innerHTML =
        '<p class="muted small" style="margin:0">呢個月未有紀錄</p>';
      return;
    }
    list.innerHTML = dayKeys
      .map((date) => {
        const t = dayTotals(byDay.get(date));
        return `
        <button type="button" class="breakdown-row as-btn" data-day="${date}">
          <div>
            <div class="breakdown-name">${formatDateZh(date)}</div>
            <div class="breakdown-detail">${t.count} 項 · ${hoursLabel(t.hours)}${
          t.bonus > 0 ? " · 額外 " + money(t.bonus) : ""
        }</div>
          </div>
          <div class="breakdown-pay-block">
            <span class="breakdown-pay">${money(t.pay)}</span>
            <div class="breakdown-calc">撳睇明細</div>
          </div>
        </button>`;
      })
      .join("");
  }

  function exportCsv() {
    const ym = document.getElementById("pay-month").value;
    const shifts = shiftsInMonth(ym);
    if (!shifts.length) {
      toast("未有可匯出資料");
      return;
    }
    const header = [
      "日期",
      "開始",
      "結束",
      "工時(小時)",
      "時薪",
      "時薪人工",
      "判頭額外",
      "合計人工",
      "位置",
      "備註",
      "類型",
    ];
    let totalH = 0;
    let totalBase = 0;
    let totalBonus = 0;
    const rows = shifts.map((s) => {
      const h = isBonusOnly(s) ? 0 : calcHours(s.date, s.start, s.end);
      const r = shiftRate(s);
      const base = calcPay(h, r);
      const bonus = shiftBonus(s);
      const p = base + bonus;
      totalH += h;
      totalBase += base;
      totalBonus += bonus;
      return [
        s.date,
        s.start || "",
        s.end || "",
        h,
        r,
        base,
        bonus,
        p,
        s.location || "",
        s.note || "",
        isBonusOnly(s) ? "判頭額外" : "返工",
      ];
    });
    const totalP = totalBase + totalBonus;
    rows.push([
      "合計",
      "",
      "",
      Math.round(totalH * 100) / 100,
      "",
      Math.round(totalBase * 100) / 100,
      Math.round(totalBonus * 100) / 100,
      Math.round(totalP * 100) / 100,
      "",
      "",
      "",
    ]);
    const bom = "\uFEFF";
    const csv =
      bom +
      [header, ...rows]
        .map((r) =>
          r
            .map((c) => {
              const v = String(c).replace(/"/g, '""');
              return /[",\n]/.test(v) ? `"${v}"` : v;
            })
            .join(",")
        )
        .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" })
    );
    a.download = `我的人工_${state.me?.name || ""}_${ym || "全部"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已匯出 · 合計 ${money(totalP)}`);
  }

  // ---------- 我 / 設定 ----------
  function fillProfileForm() {
    if (!state.me) return;
    document.getElementById("profile-name").value = state.me.name || "";
    document.getElementById("profile-rate").value = state.me.rate ?? "";
    document.getElementById("profile-phone").value = state.me.phone || "";
    const bossEl = document.getElementById("profile-boss-phone");
    if (bossEl) bossEl.value = state.me.bossPhone || "";
  }

  function saveProfile(e) {
    e.preventDefault();
    const name = document.getElementById("profile-name").value.trim();
    const rate = parseFloat(document.getElementById("profile-rate").value);
    const phone = document.getElementById("profile-phone").value.trim();
    const bossPhone = (
      document.getElementById("profile-boss-phone")?.value || ""
    ).trim();
    if (!name || isNaN(rate) || rate < 0) {
      toast("請填正確資料");
      return;
    }
    state.me = { name, rate, phone, bossPhone };
    saveState();
    updateHeader();
    updateClockUI();
    renderToday();
    renderHistory();
    renderPay();
    toast(
      bossPhone
        ? "已儲存 · 結算可直達判頭 WhatsApp"
        : "已儲存你的資料"
    );
  }

  function backupJson() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })
    );
    a.download = `我的工時備份_${state.me?.name || ""}_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已下載備份");
  }

  function restoreJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.me || !Array.isArray(data.shifts)) {
          throw new Error("格式錯誤");
        }
        if (!confirm("還原會覆蓋而家全部紀錄，確定？")) return;
        state = normalizeState({
          me: data.me,
          shifts: data.shifts,
          active: data.active || null,
          sentLog:
            data.sentLog && typeof data.sentLog === "object"
              ? data.sentLog
              : {},
          locations: data.locations || [],
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        showApp();
        toast("已還原");
      } catch {
        toast("還原失敗：檔案不正確");
      }
    };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!confirm("清除全部返工紀錄？你的名字同時薪會保留。")) return;
    if (!confirm("真係要清晒所有時段？")) return;
    state.shifts = [];
    state.active = null;
    saveState();
    updateClockUI();
    renderToday();
    renderHistory();
    renderPay();
    toast("紀錄已清除");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Tabs ----------
  function switchTab(name) {
    document.querySelectorAll(".tab-panel").forEach((p) => {
      const on = p.id === `tab-${name}`;
      p.classList.toggle("active", on);
      if (on) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });
    document.querySelectorAll(".tab-item").forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.getElementById("page-title").textContent = TITLES[name] || "今日";
    if (name === "history") renderHistory();
    if (name === "pay") renderPay();
    if (name === "today") {
      updateClockUI();
      renderToday();
    }
    if (name === "me") {
      fillProfileForm();
      updateCloudUI();
      renderLocationManage();
      fillLocationSelects();
    }
  }

  // ---------- Init ----------
  function init() {
    document.getElementById("history-month").value = monthStr();
    document.getElementById("pay-month").value = monthStr();
    document.getElementById("manual-date").value = todayStr();
    document.getElementById("bonus-date").value = todayStr();

    bindLocationPicks();
    showApp();
    // 若已登入，背景靜默同步一次
    if (auth && auth.token) {
      pullFromCloud().catch(() => {
        /* 離線時用本機 */
      });
    }
    tickClock();
    setInterval(tickClock, 1000);

    document
      .getElementById("form-onboard")
      .addEventListener("submit", onOnboard);
    document.getElementById("btn-clock-in").addEventListener("click", clockIn);
    document.getElementById("btn-clock-out").addEventListener("click", clockOut);
    document.getElementById("form-manual").addEventListener("submit", addManual);
    document.getElementById("form-bonus").addEventListener("submit", addBonusOnly);
    ["manual-date", "manual-start", "manual-end", "manual-bonus"].forEach(
      (id) => {
        const el = document.getElementById(id);
        el.addEventListener("change", updateManualPreview);
        el.addEventListener("input", updateManualPreview);
      }
    );
    updateManualPreview();

    document.querySelectorAll(".tab-item").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document
      .getElementById("history-month")
      .addEventListener("change", renderHistory);
    document.getElementById("pay-month").addEventListener("change", renderPay);

    // 今日 / 日明細：撳時段 → 編輯（刪除只喺入面有需要先做）
    document.getElementById("today-segments").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-shift-id]");
      if (btn) openEditModal(btn.dataset.shiftId);
    });
    document
      .getElementById("day-modal-segments")
      .addEventListener("click", (e) => {
        const btn = e.target.closest("[data-shift-id]");
        if (btn) openEditModal(btn.dataset.shiftId);
      });

    // 主頁以往紀錄 + 紀錄分頁 + 我的錢：按日睇
    document.getElementById("home-past-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (btn) openDayModal(btn.dataset.day);
    });
    document.getElementById("history-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (btn) openDayModal(btn.dataset.day);
    });
    document.getElementById("pay-days-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (btn) openDayModal(btn.dataset.day);
    });
    document.getElementById("btn-go-history").addEventListener("click", () => {
      switchTab("history");
    });

    document.querySelectorAll("[data-close-day]").forEach((el) => {
      el.addEventListener("click", closeDayModal);
    });
    document.querySelectorAll("[data-close-edit]").forEach((el) => {
      el.addEventListener("click", closeEditModal);
    });

    document.getElementById("form-edit").addEventListener("submit", saveEdit);
    document
      .getElementById("btn-delete-shift")
      .addEventListener("click", deleteShift);
    ["edit-date", "edit-start", "edit-end", "edit-bonus"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("change", updateEditPreview);
      el.addEventListener("input", updateEditPreview);
    });

    document.getElementById("form-profile").addEventListener("submit", saveProfile);
    document.getElementById("btn-export").addEventListener("click", exportCsv);

    // WhatsApp 結算
    document.getElementById("btn-wa-today").addEventListener("click", () => {
      sendDayToWhatsApp(todayStr());
    });
    document.getElementById("btn-wa-day").addEventListener("click", () => {
      const d = document.getElementById("day-modal-date").value;
      if (d) sendDayToWhatsApp(d);
    });

    // 常用地址管理
    document
      .getElementById("form-add-location")
      .addEventListener("submit", (e) => {
        e.preventDefault();
        const v = document.getElementById("new-location").value.trim();
        if (!v) {
          toast("請輸入地址");
          return;
        }
        rememberLocation(v);
        saveState();
        document.getElementById("new-location").value = "";
        fillLocationSelects();
        renderLocationManage();
        toast("已加入常用地址");
      });
    document
      .getElementById("location-manage-list")
      .addEventListener("click", (e) => {
        const btn = e.target.closest("[data-del-loc]");
        if (!btn) return;
        const loc = btn.getAttribute("data-del-loc");
        if (!confirm("由常用選項移除「" + loc + "」？\n（舊紀錄唔會刪）")) return;
        state.locations = (state.locations || []).filter((x) => x !== loc);
        saveState();
        fillLocationSelects();
        renderLocationManage();
        toast("已移除選項");
      });

    // 雲端帳號
    async function handleLoginForm(user, pass) {
      try {
        await cloudLogin(user, pass);
        closeLoginModal();
      } catch (err) {
        toast(err.message || "登入失敗");
      }
    }
    document
      .getElementById("form-cloud-login")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const u = document.getElementById("cloud-username").value.trim();
        const p = document.getElementById("cloud-password").value;
        await handleLoginForm(u, p);
      });
    document
      .getElementById("btn-cloud-register")
      .addEventListener("click", async () => {
        const u = document.getElementById("cloud-username").value.trim();
        const p = document.getElementById("cloud-password").value;
        if (!u || !p) {
          toast("請填帳號同密碼");
          return;
        }
        if (!state.me || !state.me.name) {
          toast("請先儲存名字同時薪");
          return;
        }
        try {
          await cloudRegister(u, p);
        } catch (err) {
          toast(err.message || "註冊失敗");
        }
      });
    document
      .getElementById("btn-cloud-sync")
      .addEventListener("click", () => {
        pushToCloud(false).catch((e) => toast(e.message || "同步失敗"));
      });
    document
      .getElementById("btn-cloud-pull")
      .addEventListener("click", () => {
        if (!confirm("用雲端資料覆蓋本機？本機未同步內容可能冇咗。")) return;
        pullFromCloud().catch((e) => toast(e.message || "下載失敗"));
      });
    document
      .getElementById("btn-cloud-logout")
      .addEventListener("click", cloudLogout);

    function openLoginModal() {
      document.getElementById("login-modal").classList.remove("hidden");
      document.body.style.overflow = "hidden";
    }
    function closeLoginModal() {
      document.getElementById("login-modal").classList.add("hidden");
      document.body.style.overflow = "";
    }
    document
      .getElementById("btn-onboard-login")
      .addEventListener("click", openLoginModal);
    document.querySelectorAll("[data-close-login]").forEach((el) => {
      el.addEventListener("click", closeLoginModal);
    });
    document
      .getElementById("form-login-modal")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const u = document.getElementById("login-modal-user").value.trim();
        const p = document.getElementById("login-modal-pass").value;
        await handleLoginForm(u, p);
      });
    document.getElementById("btn-backup").addEventListener("click", backupJson);
    document.getElementById("btn-clear").addEventListener("click", clearAll);
    document.getElementById("input-restore").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) restoreJson(f);
      e.target.value = "";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
