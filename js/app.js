/* ==========================================================================
   天机三彩 · 应用层
   纯浏览器 / 无依赖 / 离线运行
   ========================================================================== */
(function () {
  "use strict";

  const DATA = window.LOTTERY_DATA;
  const E = window.SancaiEngine;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const pad2 = (n) => String(n).padStart(2, "0");
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0);
  const round1 = (n) => Math.round(n * 10) / 10;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const CN_DIGITS = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];
  const KL8_CN = { 10: "选十", 9: "选九", 8: "选八", 7: "选七", 6: "选六", 5: "选五", 4: "选四", 3: "选三", 2: "选二", 1: "选一" };
  const STRATEGY_GLYPHS = { balanced: "衡", hot: "热", cold: "冷", golden: "黄", markov: "联", random: "随" };
  const ORACLE_LINES = [
    "冷热相生，奇偶相济",
    "数有起伏，心贵从容",
    "取中守衡，静待天时",
    "三区有序，落子无声",
    "不执一隅，方见全局",
    "顺势而为，随缘而止",
    "热极思冷，静极生动",
    "万物有数，一笑置之",
  ];

  const STORAGE_SETTINGS = "sancai.settings.v1";
  const STORAGE_SAVED = "sancai.saved.v1";
  const TREND_LABELS = {
    sum: { label: "和值", unit: "点" },
    span: { label: "跨度", unit: "点" },
    odd: { label: "奇数个数", unit: "个" },
    repeat: { label: "重号", unit: "个" },
  };
  const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    game: "dlt",
    strategy: "balanced",
    count: 1,
    pick: 10,
    windowSize: 100,
    filters: { odd: true, size: true, sum: true, consecutive: true, coverage: true },
    excluded: {
      dlt: { main: new Set(), special: new Set() },
      ssq: { main: new Set(), special: new Set() },
      kl8: { main: new Set() },
    },
    results: {},
    selected: 0,
    historyRows: 10,
    trendMetric: "sum",
    saved: [],
    ready: false,
    busy: false,
    pendingGenerate: false,
    lastLabKey: "",
  };

  let statsCache = { key: "", stats: null };
  let generateTimer = 0;
  let toastTimer = 0;
  let toastHideTimer = 0;
  let resizeTimer = 0;
  let scoreAnimToken = 0;
  let backtestBusy = false;

  /* ------------------------------- Storage -------------------------------- */
  function readStorage(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* localStorage 可能被浏览器策略禁用，忽略即可 */
    }
  }
  function loadSettings() {
    const saved = readStorage(STORAGE_SETTINGS);
    if (!saved || typeof saved !== "object") return;
    if (E.GAMES[saved.game]) state.game = saved.game;
    if (E.STRATEGIES[saved.strategy]) state.strategy = saved.strategy;
    if (Number.isInteger(saved.count)) state.count = clamp(saved.count, 1, 10);
    if (Number.isInteger(saved.pick)) state.pick = clamp(saved.pick, 1, 10);
    if (Number.isFinite(Number(saved.windowSize))) state.windowSize = Number(saved.windowSize);
    if (saved.filters && typeof saved.filters === "object") {
      for (const key of Object.keys(state.filters)) {
        if (typeof saved.filters[key] === "boolean") state.filters[key] = saved.filters[key];
      }
    }
  }
  function persistSettings() {
    writeStorage(STORAGE_SETTINGS, {
      game: state.game,
      strategy: state.strategy,
      count: state.count,
      pick: state.pick,
      windowSize: state.windowSize,
      filters: state.filters,
    });
  }
  function loadSaved() {
    const saved = readStorage(STORAGE_SAVED);
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (item) =>
        item &&
        E.GAMES[item.game] &&
        Array.isArray(item.main) &&
        item.main.every((n) => Number.isInteger(n)) &&
        (!item.special || Array.isArray(item.special))
    );
  }

  /* -------------------------------- Helpers -------------------------------- */
  function drawsOf(game = state.game) {
    return DATA.games[game].draws;
  }
  function latestOf(game = state.game) {
    return drawsOf(game)[drawsOf(game).length - 1];
  }
  function effectiveWindow(game = state.game) {
    const all = drawsOf(game).length;
    return state.windowSize > 0 ? Math.min(state.windowSize, all) : all;
  }
  function nextIssue(game = state.game) {
    const issue = String(latestOf(game).issue);
    return String(Number(issue) + 1).padStart(issue.length, "0");
  }
  function parseYmd(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  function nextDrawInfo(game = state.game) {
    const cfg = E.GAMES[game];
    const latest = latestOf(game);
    const candidate = parseYmd(latest.date);
    for (let i = 0; i < 14; i++) {
      candidate.setDate(candidate.getDate() + 1);
      if (cfg.drawDays.includes(candidate.getDay())) break;
    }
    const today = startOfToday();
    const days = Math.round((candidate - today) / 86400000);
    return {
      date: candidate,
      days,
      stale: days < 0,
      label: `${candidate.getMonth() + 1}月${candidate.getDate()}日 · ${WEEKDAYS[candidate.getDay()]}`,
    };
  }
  function formatMoneyParts(value) {
    if (!Number.isFinite(value) || value <= 0) return { value: "—", unit: "" };
    if (value >= 1e8) return { value: (value / 1e8).toFixed(2), unit: "亿" };
    if (value >= 1e4) return { value: (value / 1e4).toFixed(0), unit: "万" };
    return { value: String(Math.round(value)), unit: "" };
  }
  function formatMoneyText(value) {
    const p = formatMoneyParts(value);
    return p.unit ? `${p.value}${p.unit}` : p.value;
  }
  function getStats() {
    const window = effectiveWindow();
    const result = state.results[state.game];
    if (result && result.meta.windowSize === window) return result.stats;
    const key = `${state.game}|${window}|${drawsOf(state.game).length}`;
    if (statsCache.key !== key) {
      statsCache = {
        key,
        stats: E.prepare(state.game, drawsOf(state.game), state.windowSize),
      };
    }
    return statsCache.stats;
  }
  function mainTone() {
    return state.game === "kl8" ? "gold" : "red";
  }
  function staticBall(n, tone) {
    return `<span class="ball ${tone}">${pad2(n)}</span>`;
  }
  function dataBall(n, tone, max) {
    return `<span class="ball ${tone}" data-final="${pad2(n)}" data-max="${max}">${pad2(n)}</span>`;
  }
  function zonesOf(game = state.game) {
    if (game === "kl8") {
      return [{ key: "main", label: "号码", max: 80, pick: state.pick, cols: 10, tone: "gold" }];
    }
    const cfg = E.GAMES[game];
    return [
      {
        key: "main",
        label: cfg.mainLabel,
        max: cfg.main.max,
        pick: cfg.main.pick,
        cols: game === "dlt" ? 7 : 6,
        tone: "red",
      },
      {
        key: "special",
        label: cfg.specialLabel,
        max: cfg.special.max,
        pick: cfg.special.pick,
        cols: game === "dlt" ? 6 : 8,
        tone: "blue",
      },
    ];
  }
  function consecutiveGroups(numbers) {
    let groups = 0;
    let run = 1;
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] === numbers[i - 1] + 1) run++;
      else {
        if (run >= 2) groups++;
        run = 1;
      }
    }
    if (run >= 2) groups++;
    return groups;
  }
  function zoneBoundaries(max) {
    const end0 = Math.ceil(max / 3);
    const end1 = Math.ceil((max * 2) / 3);
    return [
      [1, end0],
      [end0 + 1, end1],
      [end1 + 1, max],
    ];
  }
  function toast(message) {
    const el = $("#toast");
    const text = $("#toast-text");
    if (!el || !text) return;
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    text.textContent = message;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("is-show"));
    toastTimer = window.setTimeout(() => {
      el.classList.remove("is-show");
      toastHideTimer = window.setTimeout(() => {
        el.hidden = true;
      }, 300);
    }, 2600);
  }
  function showBootError(message) {
    const boot = $("#boot");
    if (!boot) return;
    boot.classList.remove("is-hidden");
    boot.classList.add("has-error");
    const status = $(".boot-status", boot);
    if (status) status.textContent = message;
  }
  function hideBoot() {
    const boot = $("#boot");
    if (boot) boot.classList.add("is-hidden");
  }
  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
    } catch {
      return "--:--";
    }
  }
  function formatSavedTime(iso) {
    try {
      const d = new Date(iso);
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    } catch {
      return "";
    }
  }
  function drawNumbers(ticket, game = state.game) {
    const main = ticket.main.map((n) => pad2(n)).join(" ");
    if (game === "kl8") return `选十 ${main}`;
    return `${main} + ${ticket.special.map((n) => pad2(n)).join(" ")}`;
  }

  /* ------------------------------ Render shell ----------------------------- */
  function renderHeader() {
    const cfg = E.GAMES[state.game];
    const latest = latestOf();
    const info = nextDrawInfo();
    document.documentElement.dataset.game = state.game;
    document.title = `${cfg.name} · 天机三彩`;
    $("#hero-en").textContent = cfg.en;
    $("#hero-name").textContent = cfg.name;
    $("#hero-desc").textContent = cfg.description;
    $("#hero-issue").textContent = `第 ${latest.issue} 期`;
    $("#hero-draw-date").textContent = latest.date;
    $("#hero-samples").textContent = drawsOf().length;
    $("#hero-asof").textContent = latest.date;

    const pool = formatMoneyParts(latest.pool);
    $("#stat-pool").innerHTML = `${pool.value}${pool.unit ? `<span>${pool.unit}</span>` : ""}`;
    const sales = formatMoneyParts(latest.sales);
    $("#stat-sales").innerHTML = `${sales.value}${sales.unit ? `<span>${sales.unit}</span>` : ""}`;
    $("#stat-first-label").innerHTML = `${state.game === "kl8" ? "选十头奖" : "头奖注数"} <small>JACKPOT</small>`;
    const firstCount = Number.isFinite(latest.firstPrizeCount) ? latest.firstPrizeCount : null;
    $("#stat-first").innerHTML = firstCount === null ? "—" : `${firstCount}<span>注</span>`;
    $("#stat-first-note").textContent = Number.isFinite(latest.firstPrize)
      ? `单注约 ${formatMoneyText(latest.firstPrize)}`
      : "头奖明细";
    $("#stat-sum").innerHTML = `${sum(latest.main)}<span>点</span>`;
    const sumNote = $("#stat-sum-note");
    if (sumNote) sumNote.textContent = state.game === "kl8" ? "开奖号码之和" : "主区号码之和";
    renderCountdown();
    updateOddsCurrent();
    updateLabLabel();
    $("#footer-asof").textContent = DATA.meta.asOf;
  }

  function renderCountdown() {
    const info = nextDrawInfo();
    const dateEl = $("#hero-countdown");
    const daysEl = $("#hero-days");
    if (!dateEl || !daysEl) return;
    dateEl.textContent = info.label;
    if (info.stale) {
      daysEl.textContent = "数据待更新";
      daysEl.classList.add("is-stale");
    } else if (info.days === 0) {
      daysEl.textContent = "今天开奖";
      daysEl.classList.remove("is-stale");
    } else if (info.days === 1) {
      daysEl.textContent = "明天开奖";
      daysEl.classList.remove("is-stale");
    } else {
      daysEl.textContent = `还有 ${info.days} 天`;
      daysEl.classList.remove("is-stale");
    }
  }

  function updateOddsCurrent() {
    $$(".odd-card").forEach((card) => {
      card.classList.toggle("is-current", card.dataset.oddGame === state.game);
    });
  }
  function updateLabLabel() {
    const el = $("#lab-game");
    if (!el) return;
    el.textContent = `${E.GAMES[state.game].name} · ${E.STRATEGIES[state.strategy].name}`;
  }

  function updateNav() {
    $$("#game-nav .game-tab").forEach((button) => {
      const active = button.dataset.game === state.game;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function renderStrategies() {
    const list = $("#strategy-list");
    if (!list) return;
    list.innerHTML = Object.values(E.STRATEGIES)
      .map(
        (strategy) => `<button type="button" class="strategy-item" role="radio" data-strategy="${strategy.key}" aria-checked="false">
          <span class="strategy-glyph" aria-hidden="true">${STRATEGY_GLYPHS[strategy.key] || "·"}</span>
          <span class="strategy-text"><b>${strategy.name}</b><small>${strategy.desc}</small></span>
          <span class="strategy-dot" aria-hidden="true"></span>
        </button>`
      )
      .join("");
    renderStrategyState();
  }
  function renderStrategyState() {
    $$("#strategy-list .strategy-item").forEach((button) => {
      const active = button.dataset.strategy === state.strategy;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });
    updateLabLabel();
  }
  function renderFilters() {
    $$("#filter-toggles input[data-filter]").forEach((input) => {
      input.checked = Boolean(state.filters[input.dataset.filter]);
    });
  }
  function renderPickChips() {
    const section = $("#pick-section");
    if (!section) return;
    const isKl8 = state.game === "kl8";
    section.hidden = !isKl8;
    if (!isKl8) {
      updateFoot();
      return;
    }
    if (state.pick < 1 || state.pick > 10) state.pick = 10;
    $("#pick-chips").innerHTML = E.getPickOptions("kl8")
      .map(
        (pick) =>
          `<button type="button" class="pick-chip ${pick === state.pick ? "is-active" : ""}" data-pick="${pick}" aria-pressed="${pick === state.pick}">${KL8_CN[pick]}</button>`
      )
      .join("");
    updateFoot();
  }
  function updateFoot() {
    const el = $("#foot-window");
    if (!el) return;
    const windowSize = effectiveWindow();
    el.textContent = windowSize;
    const foot = $(".control-foot");
    if (!foot) return;
    if (state.game === "kl8" && state.pick < 4) {
      foot.innerHTML = `当前为「${KL8_CN[state.pick]}」玩法 · 结构过滤不生效 · 仅供娱乐`;
    } else {
      foot.innerHTML = `基于 <b id="foot-window">${windowSize}</b> 期统计 · 只生成结构均衡的号码`;
    }
  }
  function renderWindowOptions() {
    const select = $("#window-select");
    if (!select) return;
    const all = drawsOf().length;
    const rawValues = state.game === "kl8" ? [50, 100, 200, 300, 0] : [30, 50, 100, 200, 0];
    const options = rawValues
      .map((value) => ({ value, effective: value === 0 ? all : value }))
      .filter((option) => option.effective <= all);
    const allSelected = state.windowSize === 0;
    const valid = options.some((option) =>
      option.value === 0 ? allSelected : option.effective === state.windowSize
    );
    if (!valid) state.windowSize = 100;
    if (!options.some((option) => option.value === 0 ? state.windowSize === 0 : option.effective === state.windowSize)) {
      state.windowSize = options[0].effective;
    }
    select.innerHTML = options
      .map((option) => {
        const effective = option.effective;
        const selected = option.value === 0 ? state.windowSize === 0 : effective === state.windowSize;
        const label = option.value === 0 ? `全部 ${all} 期` : `近 ${effective} 期`;
        return `<option value="${option.value}" ${selected ? "selected" : ""}>${label}</option>`;
      })
      .join("");
    updateFoot();
  }
  function renderExcluded() {
    const box = $("#excluded-box");
    if (!box) return;
    const gameExcluded = state.excluded[state.game];
    const zones = zonesOf();
    let html = "";
    for (const zone of zones) {
      const nums = Array.from(gameExcluded[zone.key] || []).sort((a, b) => a - b);
      if (!nums.length) continue;
      html += nums
        .map(
          (n) =>
            `<button type="button" class="excluded-chip" data-zone="${zone.key}" data-n="${n}" aria-label="移除杀号 ${n}">${pad2(n)}<em>×</em></button>`
        )
        .join("");
    }
    if (!html) {
      box.innerHTML = `<span class="excluded-empty">点击右侧「号码温度」即可杀号</span>`;
    } else {
      box.innerHTML = html;
    }
  }

  function renderLatest() {
    const cfg = E.GAMES[state.game];
    const latest = latestOf();
    $("#latest-issue").textContent = `第 ${latest.issue} 期`;
    $("#latest-date").textContent = latest.date;
    const balls = latest.main.map((n) => staticBall(n, mainTone()));
    if (cfg.special && latest.special?.length) {
      balls.push('<span class="ball-plus">+</span>');
      latest.special.forEach((n) => balls.push(staticBall(n, "blue")));
    }
    $("#latest-balls").innerHTML = balls.join("");
    $("#latest-pool").textContent = `¥${formatMoneyText(latest.pool)}`;
    $("#latest-first").textContent =
      Number.isFinite(latest.firstPrizeCount) ? `${latest.firstPrizeCount} 注` : "—";
  }

  /* ------------------------------- Heat / rank ----------------------------- */
  function heatColor(heat) {
    const h = clamp(Number(heat) || 0, 0, 1);
    const cold = [27, 43, 63];
    const mid = [86, 69, 47];
    const hot = [127, 51, 40];
    let from;
    let to;
    let t;
    if (h < 0.5) {
      from = cold;
      to = mid;
      t = h / 0.5;
    } else {
      from = mid;
      to = hot;
      t = (h - 0.5) / 0.5;
    }
    const rgb = from.map((value, index) => Math.round(value + (to[index] - value) * t));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }
  function renderHeatmap() {
    const stats = getStats();
    const gameExcluded = state.excluded[state.game];
    const zones = zonesOf();
    const compact = state.game === "kl8";
    const parts = [];

    for (const zone of zones) {
      const zoneStats = stats[zone.key];
      if (!zoneStats) continue;
      const killed = gameExcluded[zone.key] || new Set();
      const rangeText =
        state.game === "kl8"
          ? "01-80"
          : zone.key === "main"
            ? `01-${pad2(zone.max)}`
            : `01-${pad2(zone.max)}`;
      const cells = zoneStats.list
        .map((item) => {
          const isKilled = killed.has(item.n);
          const title = `${pad2(item.n)} · 出现 ${item.freq} 次 · 当前遗漏 ${item.omission} 期 · 近 ${stats.windowSize} 期`;
          return `<button type="button" class="heat-cell ${isKilled ? "is-killed" : ""}" data-zone="${zone.key}" data-n="${item.n}" style="--cell:${heatColor(item.heat)}" title="${title}" aria-label="${title}" aria-pressed="${isKilled}">${pad2(item.n)}<i>${item.omission}</i></button>`;
        })
        .join("");
      parts.push(`<div class="heat-zone">
        <div class="heat-zone-head"><b>${state.game === "kl8" ? "全部号码" : zone.label} ${rangeText}</b><span>近 ${stats.windowSize} 期</span></div>
        <div class="heat-grid ${compact ? "compact" : ""}" style="--cols:${zone.cols}">${cells}</div>
      </div>`);
    }
    $("#heatmap").innerHTML = parts.join("");
    $("#rank-window").textContent = stats.windowSize;
    renderRank(stats);
  }

  function renderRank(stats) {
    const zone = stats.main;
    const hot = zone.hotRanked.slice(0, 5);
    const cold = zone.coldRanked.slice(0, 5);
    const tone = mainTone();
    const hotRows = hot
      .map(
        (item) =>
          `<div class="rank-row">${staticBall(item.n, tone)}<span>出现 ${item.freq} 次</span><b>${item.freqPct.toFixed(0)}<small>%</small></b></div>`
      )
      .join("");
    const coldRows = cold
      .map(
        (item) =>
          `<div class="rank-row">${staticBall(item.n, tone)}<span>遗漏 ${item.omission} 期</span><b>${item.freq}<small>次</small></b></div>`
      )
      .join("");
    $("#rank-columns").innerHTML = `
      <div><div class="rank-col-head"><i></i>热号追击</div>${hotRows}</div>
      <div><div class="rank-col-head cold"><i></i>冷号回补</div>${coldRows}</div>`;
  }

  /* ------------------------------- Tickets -------------------------------- */
  const LOADING_HTML = `<div class="ticket-loading"><span class="spinner"></span><p>正在排布天机</p></div>`;
  const ERROR_HTML = `<div class="ticket-loading"><p>推演暂不可用</p><p style="font-size:8px;color:var(--faint)">请清除部分杀号或刷新页面重试</p></div>`;

  function showLoading() {
    const area = $("#ticket-area");
    if (!area) return;
    area.innerHTML = LOADING_HTML;
    area.className = "ticket-area";
  }

  function ticketTags(ticket, density) {
    const m = ticket.metrics;
    const tags = [
      ["和值", m.sum],
      ["奇偶", m.oddEven],
      ["大小", m.sizeRatio],
      ["三区", m.zoneRatio],
      ["连号", m.consecutiveGroups ? `${m.consecutiveGroups}组` : "无"],
      ["跨度", m.span],
    ];
    const maxTags = density >= 4 ? 2 : density === 3 ? 4 : 6;
    return tags
      .slice(0, maxTags)
      .map(([label, value]) => `<span class="ticket-tag">${label}<b>${value}</b></span>`)
      .join("");
  }

  function ticketHTML(ticket, index, game, density) {
    const cfg = E.GAMES[game];
    const tone = mainTone();
    const mainBalls = ticket.main.map((n) => dataBall(n, tone, cfg.main.max)).join("");
    const specialBalls = ticket.special?.length
      ? `<span class="ball-group-special"><span class="ball-plus" aria-hidden="true">+</span>${ticket.special.map((n) => dataBall(n, "blue", cfg.special.max)).join("")}</span>`
      : "";
    const numbersText =
      ticket.main.map((n) => pad2(n)).join(" ") +
      (ticket.special?.length ? ` + ${ticket.special.map((n) => pad2(n)).join(" ")}` : "");
    return `<article class="ticket ${index === state.selected ? "is-selected" : ""}" data-index="${index}" role="button" tabindex="0" aria-label="第 ${index + 1} 注 ${numbersText}，结构分 ${Math.round(ticket.score)}">
      <div class="ticket-index"><b>${CN_DIGITS[index + 1] || index + 1}</b><em>${pad2(index + 1)}</em></div>
      <div class="ticket-main">
        <div class="ball-row">${mainBalls}${specialBalls}</div>
        <div class="ticket-tags">${ticketTags(ticket, density)}</div>
      </div>
      <div class="ticket-side">
        <strong>${Math.round(ticket.score)}</strong>
        <span>结构分</span>
        <em>和值 ${ticket.metrics.sum}</em>
      </div>
    </article>`;
  }

  function densityOf(ticketCount, pick) {
    if (ticketCount === 1) return pick <= 7 ? 1 : 2;
    if (ticketCount <= 3) return 2;
    if (ticketCount <= 6) return 3;
    return 4;
  }

  function renderTickets(animate) {
    const area = $("#ticket-area");
    const result = state.results[state.game];
    if (!area) return;
    if (!result) {
      showLoading();
      return;
    }
    const tickets = result.tickets;
    const density = densityOf(tickets.length, result.meta.pick);
    area.className = `ticket-area density-${density}`;
    area.innerHTML = tickets
      .map((ticket, index) => ticketHTML(ticket, index, state.game, density))
      .join("");
    if (animate) {
      $$(".ticket", area).forEach((ticketEl, index) => {
        ticketEl.classList.add("reveal");
        ticketEl.style.animationDelay = `${Math.min(index * 45, 360)}ms`;
      });
    }

    if (tickets.length === 1 && density <= 2) {
      const ticket = tickets[0];
      const seed = sum(ticket.main) + (ticket.special?.length ? sum(ticket.special) : 0);
      const line = ORACLE_LINES[seed % ORACLE_LINES.length];
      const quote = document.createElement("div");
      quote.className = "single-oracle";
      quote.innerHTML = `<p>「${line}」</p><small>天机三彩 · 结构选号签</small>`;
      area.appendChild(quote);
    }
    if (animate) animateBalls(area);
  }

  function animateBalls(scope) {
    if (REDUCED_MOTION) return;
    const balls = $$(".ball[data-final]", scope).slice(0, 54);
    balls.forEach((ball, index) => {
      const final = ball.dataset.final;
      const max = Number(ball.dataset.max) || 35;
      window.setTimeout(() => {
        ball.classList.add("rolling");
        let ticks = 0;
        const timer = window.setInterval(() => {
          ball.textContent = pad2(1 + Math.floor(Math.random() * max));
          ball.classList.add("rolling");
          if (++ticks >= 5) {
            window.clearInterval(timer);
            ball.textContent = final;
            ball.classList.remove("rolling");
            ball.classList.add("locked");
            window.setTimeout(() => ball.classList.remove("locked"), 520);
          }
        }, 46);
      }, index * 9);
    });
  }

  function selectTicket(index) {
    const result = state.results[state.game];
    if (!result || !result.tickets[index]) return;
    state.selected = index;
    $$("#ticket-area .ticket").forEach((ticket) => {
      ticket.classList.toggle("is-selected", Number(ticket.dataset.index) === index);
    });
    renderReport();
  }

  function selectedTicket() {
    const result = state.results[state.game];
    if (!result || !result.tickets.length) return null;
    return result.tickets[clamp(state.selected, 0, result.tickets.length - 1)];
  }

  function animateScore(element, to) {
    const token = ++scoreAnimToken;
    const from = Number(element.dataset.value) || 0;
    element.dataset.value = String(to);
    if (REDUCED_MOTION) {
      element.textContent = String(Math.round(to));
      return;
    }
    const start = performance.now();
    const duration = 520;
    function step(now) {
      if (token !== scoreAnimToken) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = String(Math.round(from + (to - from) * eased));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function renderRadar(ticket) {
    const container = $("#radar-chart");
    if (!container) return;
    const values = ticket
      ? [
          ticket.subscores.heat,
          ticket.subscores.odd,
          ticket.subscores.size,
          ticket.subscores.sum,
          ticket.subscores.coverage,
          ticket.subscores.consecutive,
        ]
      : [0, 0, 0, 0, 0, 0];
    const labels = ["冷热", "奇偶", "大小", "和值", "区间", "连号"];
    const W = 260;
    const H = 190;
    const cx = 130;
    const cy = 95;
    const radius = 60;
    const count = 6;
    const point = (i, r) => {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / count;
      return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
    };
    let grid = "";
    for (const ratio of [1 / 3, 2 / 3, 1]) {
      const pts = [];
      for (let i = 0; i < count; i++) pts.push(point(i, radius * ratio).map((v) => v.toFixed(2)).join(","));
      grid += `<polygon points="${pts.join(" ")}" fill="none" stroke="rgba(255,255,255,${ratio === 1 ? 0.14 : 0.06})" stroke-width="0.8"/>`;
    }
    let spokes = "";
    for (let i = 0; i < count; i++) {
      const [x, y] = point(i, radius);
      spokes += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.075)" stroke-width="0.8"/>`;
    }
    const dataPoints = values.map((value, i) => point(i, radius * clamp(value / 100, 0, 1)));
    const polygon = dataPoints.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ");
    const dots = dataPoints
      .map(([x, y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2" fill="rgba(241,223,174,0.95)"/>`)
      .join("");
    let axisLabels = "";
    for (let i = 0; i < count; i++) {
      const [x, y] = point(i, radius + 21);
      const anchor = x < cx - 6 ? "end" : x > cx + 6 ? "start" : "middle";
      axisLabels += `<text x="${x.toFixed(2)}" y="${(y + 3).toFixed(2)}" text-anchor="${anchor}" class="radar-label">${labels[i]}</text>`;
    }
    const showData = ticket ? "" : 'opacity="0"';
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="结构雷达图">
      ${grid}${spokes}
      <polygon ${showData} points="${polygon}" fill="rgba(216,184,108,0.16)" stroke="rgba(216,184,108,0.9)" stroke-width="1.4" stroke-linejoin="round"/>
      ${showData}${dots}
      <text x="${cx}" y="${cy + 8}" text-anchor="middle" fill="rgba(216,184,108,0.17)" font-family="STKaiti,KaiTi,serif" font-size="27">衡</text>
      ${axisLabels}
    </svg>`;
  }

  function renderReport() {
    const ticket = selectedTicket();
    const scoreEl = $("#report-score");
    const barsEl = $("#report-bars");
    const noteEl = $("#report-note");
    if (!ticket) {
      if (scoreEl) {
        scoreEl.textContent = "--";
        scoreEl.dataset.value = "0";
      }
      if (barsEl) barsEl.innerHTML = "";
      if (noteEl) noteEl.textContent = "结构评分衡量号码分布均衡度，与中奖概率无关。";
      renderRadar(null);
      return;
    }
    if (scoreEl) animateScore(scoreEl, ticket.score);
    const metrics = [
      ["冷热平衡", ticket.subscores.heat],
      ["和值中枢", ticket.subscores.sum],
      ["三区覆盖", ticket.subscores.coverage],
      ["连号控制", ticket.subscores.consecutive],
    ];
    if (barsEl) {
      barsEl.innerHTML = metrics
        .map(
          ([label, value]) => `<div class="report-bar"><span>${label}</span><div class="report-bar-track"><i data-width="${clamp(value, 0, 100)}"></i></div><b>${Math.round(value)}</b></div>`
        )
        .join("");
      requestAnimationFrame(() => {
        $$("#report-bars .report-bar-track i").forEach((bar) => {
          bar.style.width = `${bar.dataset.width}%`;
        });
      });
    }
    if (noteEl) {
      noteEl.textContent = `结构分 ${ticket.score.toFixed(1)} · 和值 ${ticket.metrics.sum} · 跨度 ${ticket.metrics.span} · AC ${ticket.metrics.ac}。评分只描述分布均衡度，与中奖概率无关。`;
    }
    renderRadar(ticket);
  }

  function renderStageMeta() {
    const el = $("#stage-meta");
    if (!el) return;
    const result = state.results[state.game];
    const issue = nextIssue();
    if (!result) {
      el.textContent = `第 ${issue} 期 · ${E.STRATEGIES[state.strategy].name}`;
      return;
    }
    el.textContent = `第 ${issue} 期 · ${result.meta.strategyName} · ${formatTime(result.meta.generatedAt)}`;
  }

  function renderAnalysis() {
    renderHeatmap();
    renderStructure();
  }

  /* -------------------------------- Trend --------------------------------- */
  function trendValues() {
    const metric = state.trendMetric;
    const all = drawsOf();
    const count = Math.min(50, all.length);
    const start = all.length - count;
    const slice = all.slice(start);
    return slice.map((draw, index) => {
      const actualIndex = start + index;
      if (metric === "sum") return sum(draw.main);
      if (metric === "span") return Math.max(...draw.main) - Math.min(...draw.main);
      if (metric === "odd") return draw.main.filter((n) => n % 2 === 1).length;
      if (metric === "repeat") {
        if (actualIndex === 0) return 0;
        const previous = all[actualIndex - 1].main;
        const set = new Set(previous);
        return draw.main.reduce((acc, n) => acc + (set.has(n) ? 1 : 0), 0);
      }
      return 0;
    });
  }

  function renderTrend() {
    const chart = $("#trend-chart");
    if (!chart) return;
    const cfg = E.GAMES[state.game];
    const all = drawsOf();
    const count = Math.min(50, all.length);
    const draws = all.slice(all.length - count);
    const values = trendValues();
    const labels = TREND_LABELS[state.trendMetric];
    const W = Math.max(320, Math.round(chart.clientWidth || 900));
    const H = Math.max(180, Math.round(chart.clientHeight || 266));
    const pad = { l: 38, r: 16, t: 18, b: 26 };
    const plotW = Math.max(10, W - pad.l - pad.r);
    const plotH = Math.max(10, H - pad.t - pad.b);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const margin = Math.max(1, (rawMax - rawMin) * 0.16);
    const yMin = Math.floor(rawMin - margin);
    const yMax = Math.ceil(rawMax + margin);
    const yRange = Math.max(1, yMax - yMin);
    const xOf = (index) => pad.l + (count <= 1 ? plotW / 2 : (index / (count - 1)) * plotW);
    const yOf = (value) => pad.t + plotH - ((value - yMin) / yRange) * plotH;
    const avgValue = avg(values);
    const avgY = yOf(avgValue);
    const points = values.map((value, index) => ({ x: xOf(index), y: yOf(value), value, draw: draws[index], issue: draws[index].issue, date: draws[index].date }));

    let grid = "";
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const value = yMin + (yRange * i) / gridCount;
      const y = pad.t + plotH - (plotH * i) / gridCount;
      grid += `<line class="trend-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/>
        <text class="trend-axis-label" x="${pad.l - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(value)}</text>`;
    }

    const linePoints = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    const areaPath = points.length
      ? `M ${points[0].x.toFixed(2)} ${(pad.t + plotH).toFixed(2)} L ${linePoints.replace(/ /g, " L ")} L ${points[points.length - 1].x.toFixed(2)} ${(pad.t + plotH).toFixed(2)} Z`
      : "";
    const labelIndices = Array.from(
      new Set([0, Math.round((count - 1) * 0.25), Math.round((count - 1) * 0.5), Math.round((count - 1) * 0.75), count - 1])
    ).filter((i) => i >= 0 && i < count);
    let xLabels = "";
    for (const index of labelIndices) {
      const point = points[index];
      const anchor = index === 0 ? "start" : index === count - 1 ? "end" : "middle";
      xLabels += `<text class="trend-x-label" x="${point.x.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${point.issue}</text>`;
    }
    const dots = points
      .map(
        (point, index) =>
          `<circle class="trend-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${index === points.length - 1 ? 2.8 : 1.7}" opacity="${index === points.length - 1 ? 1 : 0.55}"/>`
      )
      .join("");
    const last = points[points.length - 1];
    const lastLabel = last
      ? `<text x="${last.x - 4}" y="${last.y - 8}" text-anchor="end" fill="rgba(241,223,174,0.85)" font-family="Bahnschrift,Consolas,monospace" font-size="9">${last.value}</text>`
      : "";

    chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label="近 ${count} 期${labels.label}走势图">
      <defs>
        <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(216,184,108,0.22)"/>
          <stop offset="100%" stop-color="rgba(216,184,108,0)"/>
        </linearGradient>
      </defs>
      ${grid}
      ${areaPath ? `<path class="trend-area" d="${areaPath}"/>` : ""}
      ${linePoints ? `<polyline class="trend-line" points="${linePoints}"/>` : ""}
      ${dots}
      <line class="trend-avg" x1="${pad.l}" y1="${avgY.toFixed(1)}" x2="${W - pad.r}" y2="${avgY.toFixed(1)}"/>
      <text class="trend-avg-label" x="${pad.l + 5}" y="${Math.max(pad.t + 9, avgY - 5).toFixed(1)}" text-anchor="start">均值 ${round1(avgValue)}</text>
      ${lastLabel}
      ${xLabels}
      <line class="trend-hover-line" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + plotH}" opacity="0"/>
      <circle class="trend-hover-dot" cx="0" cy="0" r="4" opacity="0"/>
    </svg>`;
    state.trendMeta = { points, W, H, labels, chart };
    renderTrendStats(values, labels, avgValue);
  }

  function renderTrendStats(values, labels, average) {
    const max = Math.max(...values);
    const min = Math.min(...values);
    const latest = values[values.length - 1];
    const variance = avg(values.map((v) => (v - average) ** 2));
    const std = Math.sqrt(variance);
    const items = [
      ["均值", round1(average), labels.unit],
      ["最高", max, labels.unit],
      ["最低", min, labels.unit],
      ["波动", round1(std), labels.unit],
      ["最新", latest, labels.unit],
    ];
    $("#trend-stats").innerHTML = items
      .map(
        ([label, value, unit]) =>
          `<div class="trend-stat"><span>${label}</span><b>${value}<small>${unit}</small></b></div>`
      )
      .join("");
    $$("#trend-tabs button").forEach((button) => {
      const active = button.dataset.metric === state.trendMetric;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function onTrendMove(event) {
    const meta = state.trendMeta;
    const tooltip = $("#trend-tooltip");
    const chart = $("#trend-chart");
    if (!meta || !tooltip || !chart || !meta.points.length) return;
    const rect = chart.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * meta.W;
    let nearest = meta.points[0];
    let minDistance = Infinity;
    for (const point of meta.points) {
      const distance = Math.abs(point.x - x);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = point;
      }
    }
    const line = $(".trend-hover-line", chart);
    const dot = $(".trend-hover-dot", chart);
    if (line) {
      line.setAttribute("x1", String(nearest.x));
      line.setAttribute("x2", String(nearest.x));
      line.setAttribute("opacity", "1");
    }
    if (dot) {
      dot.setAttribute("cx", String(nearest.x));
      dot.setAttribute("cy", String(nearest.y));
      dot.setAttribute("opacity", "1");
    }
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${nearest.value}${meta.labels.unit ? `<span style="font-size:8px;font-weight:400;color:var(--muted);margin-left:2px">${meta.labels.unit}</span>` : ""}</strong><span>第 ${nearest.issue} 期 · ${nearest.date}</span>`;
    const wrapRect = chart.parentElement.getBoundingClientRect();
    const pointX = rect.left - wrapRect.left + (nearest.x / meta.W) * rect.width;
    const pointY = rect.top - wrapRect.top + (nearest.y / meta.H) * rect.height;
    tooltip.style.left = `${clamp(pointX, 58, wrapRect.width - 58)}px`;
    tooltip.style.top = `${Math.max(34, pointY - 8)}px`;
  }
  function hideTrendTip() {
    const tooltip = $("#trend-tooltip");
    if (tooltip) tooltip.hidden = true;
    const chart = $("#trend-chart");
    if (!chart) return;
    const line = $(".trend-hover-line", chart);
    const dot = $(".trend-hover-dot", chart);
    if (line) line.setAttribute("opacity", "0");
    if (dot) dot.setAttribute("opacity", "0");
  }

  /* ------------------------------- Structure ------------------------------ */
  function renderStructure() {
    const container = $("#structure-list");
    if (!container) return;
    const stats = getStats();
    const window = stats.window;
    const cfg = E.GAMES[state.game];
    const totalNumbers = window.length * cfg.main.observed;
    const oddTotal = sum(stats.structural.oddCounts);
    const evenTotal = totalNumbers - oddTotal;
    const bigTotal = window.reduce((acc, draw) => acc + draw.main.filter((n) => n > cfg.main.max / 2).length, 0);
    const smallTotal = totalNumbers - bigTotal;
    const oddPct = totalNumbers ? (oddTotal / totalNumbers) * 100 : 0;
    const bigPct = totalNumbers ? (bigTotal / totalNumbers) * 100 : 0;
    const zoneTotals = stats.structural.zoneTotals;
    const zoneSum = sum(zoneTotals) || 1;
    const avgConsecutive = avg(window.map((draw) => consecutiveGroups(draw.main)));
    const bounds = zoneBoundaries(cfg.main.max);
    const zoneNames = ["一区", "二区", "三区"];

    const zoneLines = zoneTotals
      .map((value, index) => {
        const pct = (value / zoneSum) * 100;
        return `<div class="zone-line"><span>${zoneNames[index]}</span><div class="zone-track"><i style="width:${pct.toFixed(1)}%"></i></div><b>${pct.toFixed(0)}%</b></div>`;
      })
      .join("");

    container.innerHTML = `
      <div class="donut-grid">
        <div class="donut-card">
          <div class="donut" style="--donut:conic-gradient(var(--gold) 0 ${oddPct.toFixed(1)}%, #37507a ${oddPct.toFixed(1)}% 100%)"><span>${oddPct.toFixed(0)}%</span></div>
          <div class="donut-info"><b>奇偶结构</b>奇数 ${oddTotal} 个<br/><em>偶数 ${evenTotal} 个 · 共 ${totalNumbers} 个</em></div>
        </div>
        <div class="donut-card">
          <div class="donut" style="--donut:conic-gradient(#cf7a67 0 ${bigPct.toFixed(1)}%, #33465e ${bigPct.toFixed(1)}% 100%)"><span>${bigPct.toFixed(0)}%</span></div>
          <div class="donut-info"><b>大小结构</b>大号 ${bigTotal} 个<br/><em>小号 ${smallTotal} 个 · 以 ${cfg.main.max / 2} 为界</em></div>
        </div>
      </div>
      <div class="structure-subtitle"><span>三区分布</span><span>ZONE DIST. · 近 ${stats.windowSize} 期</span></div>
      <div class="zone-lines">
        ${zoneLines}
      </div>
      <div class="structure-mini-grid">
        <div class="structure-mini"><span>平均重号</span><b>${stats.structural.repeatAvg}<small>个</small></b></div>
        <div class="structure-mini"><span>平均连号</span><b>${avgConsecutive.toFixed(2)}<small>组</small></b></div>
        <div class="structure-mini"><span>平均跨度</span><b>${Math.round(stats.structural.meanSpan)}<small>点</small></b></div>
      </div>
      <div class="structure-subtitle" style="margin-top:1px"><span>区间范围</span><span>${bounds.map((b, i) => `${zoneNames[i]} ${pad2(b[0])}-${pad2(b[1])}`).join(" / ")}</span></div>
    `;
  }

  /* -------------------------------- History -------------------------------- */
  const HISTORY_STEPS = [10, 20, 30, 50, 100];
  function renderHistory() {
    const table = $("#history-table");
    if (!table) return;
    table.dataset.game = state.game;
    const all = drawsOf();
    const limit = Math.min(state.historyRows, all.length, 100);
    const rows = all.slice(-limit).reverse();
    const cfg = E.GAMES[state.game];
    let html = `<div class="history-row history-head" aria-hidden="true">
      <span>期号</span><span>开奖号码</span><span>和值</span><span style="text-align:right">开奖日期</span>
    </div>`;
    html += rows
      .map((draw, index) => {
        const balls = draw.main.map((n) => staticBall(n, mainTone()));
        if (cfg.special && draw.special?.length) {
          balls.push('<span class="ball-plus">+</span>');
          draw.special.forEach((n) => balls.push(staticBall(n, "blue")));
        }
        return `<div class="history-row ${index === 0 ? "is-latest" : ""}">
          <span class="history-issue">${index === 0 ? "<i></i>" : ""}<span>${draw.issue}</span></span>
          <span class="history-balls">${balls.join("")}</span>
          <span class="history-sum">${sum(draw.main)}<small>点</small></span>
          <span class="history-date" title="${draw.date}">${draw.date.slice(5)}</span>
        </div>`;
      })
      .join("");
    table.innerHTML = html;
    $("#history-range").textContent = `最近 ${limit} 期`;
    const button = $("#btn-more-history");
    if (!button) return;
    if (limit >= Math.min(all.length, 100)) {
      button.disabled = true;
      button.innerHTML = all.length <= 100 ? "已展示全部历史" : "已展示最近 100 期";
    } else {
      button.disabled = false;
      button.innerHTML = `展开更多 <span aria-hidden="true">↓</span>`;
    }
  }

  /* -------------------------------- Analysis ------------------------------- */
  function activateGame(game, options = {}) {
    if (!E.GAMES[game] || state.busy) return;
    if (!options.initial && state.game === game) return;
    state.game = game;
    state.selected = 0;
    state.historyRows = 10;
    document.documentElement.dataset.game = game;
    updateNav();
    renderHeader();
    renderWindowOptions();
    renderPickChips();
    renderStrategyState();
    renderFilters();
    renderExcluded();
    renderLatest();
    renderHistory();
    renderTrend();
    renderStageMeta();
    if (state.results[game]) {
      renderTickets(false);
      renderReport();
    } else {
      showLoading();
      renderReport();
    }
    renderAnalysis();
    hideTrendTip();
    persistSettings();
    if (!state.results[game]) requestGenerate(70);
  }

  /* ------------------------------- Generate -------------------------------- */
  function requestGenerate(delay = 0, manual = false) {
    window.clearTimeout(generateTimer);
    if (delay <= 0) {
      runGenerate({ manual });
      return;
    }
    generateTimer = window.setTimeout(() => runGenerate({ manual }), delay);
  }

  function runGenerate(options = {}) {
    const manual = Boolean(options.manual);
    if (state.busy) {
      state.pendingGenerate = true;
      return;
    }
    const game = state.game;
    const button = $("#btn-generate");
    state.busy = true;
    if (button) {
      button.disabled = true;
      button.classList.add("is-busy");
      const label = $(".generate-copy b", button);
      if (label) label.textContent = "推演中";
    }
    if (!state.results[game]) showLoading();

    window.setTimeout(() => {
      try {
        const excluded = {
          main: Array.from(state.excluded[game]?.main || []),
          special: Array.from(state.excluded[game]?.special || []),
        };
        const result = E.generate({
          game,
          draws: drawsOf(game),
          strategy: state.strategy,
          count: state.count,
          pick: state.pick,
          windowSize: state.windowSize,
          filters: state.filters,
          excluded,
          seed: E.makeSeed(`${Date.now()}-${Math.random()}-${game}`),
        });
        if (state.game !== game) return;
        state.results[game] = result;
        state.selected = 0;
        statsCache = { key: "", stats: null };
        renderTickets(true);
        renderReport();
        renderStageMeta();
        renderAnalysis();
        persistSettings();
        if (manual && result.meta.relaxed > 0) {
          toast("杀号较多，已自动放宽部分结构过滤");
        }
      } catch (error) {
        console.error(error);
        toast(error?.message || "推演失败，请稍后再试");
        if (!state.results[game]) {
          const area = $("#ticket-area");
          if (area) {
            area.className = "ticket-area";
            area.innerHTML = ERROR_HTML;
          }
        }
      } finally {
        state.busy = false;
        if (button) {
          button.disabled = false;
          button.classList.remove("is-busy");
          const label = $(".generate-copy b", button);
          if (label) label.textContent = "天机推演";
        }
        if (state.pendingGenerate) {
          state.pendingGenerate = false;
          runGenerate({ manual: false });
        }
      }
    }, 360);
  }

  /* --------------------------------- Copy --------------------------------- */
  function ticketText(ticket, index) {
    const cfg = E.GAMES[state.game];
    const numbers = ticket.main.map((n) => pad2(n)).join(" ");
    const special = ticket.special?.length ? ` + ${ticket.special.map((n) => pad2(n)).join(" ")}` : "";
    return `${CN_DIGITS[index + 1] || index + 1}  ${numbers}${special}`;
  }

  function currentText() {
    const result = state.results[state.game];
    if (!result) return "";
    const cfg = E.GAMES[state.game];
    const issue = nextIssue();
    const lines = [
      `天机三彩 · ${cfg.name}`,
      `第 ${issue} 期 · ${result.meta.strategyName}`,
      ...result.tickets.map((ticket, index) => ticketText(ticket, index)),
      "——",
      "统计结构选号，仅供娱乐。彩票随机，理性购彩。",
    ];
    return lines.join("\n");
  }

  function savedText(item) {
    const special = item.special?.length ? ` + ${item.special.map((n) => pad2(n)).join(" ")}` : "";
    return [
      `天机三彩 · ${E.GAMES[item.game]?.name || item.gameName}`,
      `第 ${item.issue} 期 · ${item.strategyName || ""}`,
      `${item.main.map((n) => pad2(n)).join(" ")}${special}`,
      "统计结构选号，仅供娱乐。",
    ].join("\n");
  }

  async function copyPlain(text) {
    if (!text) {
      toast("暂无可复制的号码");
      return false;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast("号码已复制到剪贴板");
        return true;
      }
      throw new Error("fallback");
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        area.style.top = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        if (ok) {
          toast("号码已复制到剪贴板");
          return true;
        }
      } catch {
        /* ignore */
      }
      toast("复制失败，请手动选择号码");
      return false;
    }
  }

  /* --------------------------------- Save ---------------------------------- */
  function numberKey(game, issue, main, special) {
    return `${game}|${issue}|${main.join(",")}|${(special || []).join(",")}`;
  }
  function updateSavedBadge() {
    const count = state.saved.length;
    $("#saved-count").textContent = String(count);
    const drawerCount = $("#saved-drawer-count");
    if (drawerCount) drawerCount.textContent = String(count);
  }
  function persistSaved() {
    writeStorage(STORAGE_SAVED, state.saved);
    updateSavedBadge();
  }
  function saveCurrent() {
    const result = state.results[state.game];
    if (!result) {
      toast("请先推演一组号码");
      return;
    }
    const issue = nextIssue();
    const existing = new Set(state.saved.map((item) => numberKey(item.game, item.issue, item.main, item.special || [])));
    const additions = [];
    for (const ticket of result.tickets) {
      const key = numberKey(state.game, issue, ticket.main, ticket.special || []);
      if (existing.has(key)) continue;
      existing.add(key);
      additions.push({
        id: `${key}|${Date.now()}|${Math.random().toString(36).slice(2, 7)}`,
        game: state.game,
        gameName: E.GAMES[state.game].name,
        issue,
        strategyName: result.meta.strategyName,
        main: [...ticket.main],
        special: [...(ticket.special || [])],
        score: ticket.score,
        sum: ticket.metrics.sum,
        savedAt: new Date().toISOString(),
      });
    }
    if (!additions.length) {
      toast("这些号码已经在收藏中了");
      return;
    }
    state.saved = [...additions, ...state.saved];
    persistSaved();
    renderSavedList();
    toast(`已收藏 ${additions.length} 注号码`);
  }

  function renderSavedList() {
    const list = $("#saved-list");
    if (!list) return;
    if (!state.saved.length) {
      list.innerHTML = `<div class="saved-empty"><div class="saved-seal">藏</div><p>还没有收藏的号码</p><small>推演后点击「收藏本组」，就会出现在这里</small></div>`;
      return;
    }
    list.innerHTML = state.saved
      .map((item) => {
        const cfg = E.GAMES[item.game];
        const tone = item.game === "kl8" ? "gold" : "red";
        const balls = item.main.map((n) => staticBall(n, tone));
        if (cfg?.special && item.special?.length) {
          balls.push('<span class="ball-plus">+</span>');
          item.special.forEach((n) => balls.push(staticBall(n, "blue")));
        }
        return `<article class="saved-item">
          <div class="saved-item-head">
            <span class="saved-game-badge">${cfg?.short || item.gameName}</span>
            <b>第 ${item.issue} 期</b>
            <time>${formatSavedTime(item.savedAt)}</time>
          </div>
          <div class="saved-balls">${balls.join("")}</div>
          <div class="saved-item-foot">
            <span>${item.strategyName || "结构选号"} · 结构分 ${Math.round(item.score || 0)} · 和值 ${item.sum ?? "—"}</span>
            <button type="button" class="icon-btn" data-saved-copy="${item.id}" aria-label="复制这注号码">⧉</button>
            <button type="button" class="icon-btn danger" data-saved-del="${item.id}" aria-label="删除这注收藏">×</button>
          </div>
        </article>`;
      })
      .join("");
  }

  function openDrawer() {
    closeModals();
    renderSavedList();
    const drawer = $("#drawer-saved");
    if (!drawer) return;
    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.add("is-open"));
    document.body.classList.add("is-locked");
  }
  function closeDrawer() {
    const drawer = $("#drawer-saved");
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove("is-open");
    window.setTimeout(() => {
      if (!drawer.classList.contains("is-open")) drawer.hidden = true;
      updateLock();
    }, 340);
  }

  /* -------------------------------- Modals -------------------------------- */
  function updateLock() {
    const open = $(".modal.is-open") || $(".drawer.is-open");
    document.body.classList.toggle("is-locked", Boolean(open));
  }
  function openModal(modal) {
    if (!modal) return;
    closeDrawer();
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("is-open"));
    document.body.classList.add("is-locked");
  }
  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove("is-open");
    window.setTimeout(() => {
      if (!modal.classList.contains("is-open")) modal.hidden = true;
      updateLock();
    }, 320);
  }
  function closeModals() {
    $$(".modal.is-open").forEach((modal) => closeModal(modal));
  }

  function resetLab() {
    const result = $("#lab-result");
    if (!result) return;
    result.innerHTML = `<div class="lab-placeholder"><span class="lab-compass">◎</span><p>点击运行，看看「统计选号」在历史中究竟命中了多少。</p><small>回测只做概率科普，不构成任何投注建议。</small></div>`;
  }
  function openProbability() {
    updateOddsCurrent();
    updateLabLabel();
    const key = `${state.game}|${state.strategy}|${state.windowSize}|${state.pick}|${JSON.stringify(state.filters)}`;
    if (state.lastLabKey !== key) {
      state.lastLabKey = key;
      resetLab();
    }
    openModal($("#modal-probability"));
  }
  function openAbout() {
    openModal($("#modal-about"));
  }

  function renderBacktest(result) {
    const cfg = E.GAMES[result.game];
    const mainDisplay = result.game === "kl8" ? "开奖号码" : cfg.mainLabel;
    const specialDisplay = cfg.special ? cfg.specialLabel : "特别区";
    const labels = cfg.special ? `${cfg.mainLabel} + ${cfg.specialLabel}` : "20 个开奖号码";
    const resultBox = $("#lab-result");
    const mainWidth = clamp((result.avgMain / Math.max(1, state.pick)) * 100, 4, 100);
    const theoryWidth = clamp((result.expectedMain / Math.max(1, state.pick)) * 100, 4, 100);
    const specialBlock =
      cfg.special && result.avgSpecial !== null
        ? `<div class="lab-stat"><span>策略平均命中 · ${specialDisplay}</span><strong>${result.avgSpecial}</strong><em>理论 ${result.expectedSpecial}</em><div class="lab-track"><i style="width:${clamp((result.avgSpecial / cfg.special.pick) * 100, 4, 100)}%"></i></div></div>
           <div class="lab-stat is-theory"><span>纯随机理论期望 · ${specialDisplay}</span><strong>${result.expectedSpecial}</strong><em>数学期望值</em><div class="lab-track"><i style="width:${clamp((result.expectedSpecial / cfg.special.pick) * 100, 4, 100)}%"></i></div></div>`
        : "";
    const rawDiff = result.avgMain - result.expectedMain;
    const diff = Math.abs(rawDiff) < 0.005 ? 0 : Math.round(rawDiff * 100) / 100;
    const diffText = diff > 0 ? `+${diff.toFixed(2)}` : diff < 0 ? diff.toFixed(2) : "0.00";
    const direction = diff === 0 ? "与随机期望几乎一致" : diff > 0 ? "略高于随机期望" : "略低于随机期望";
    const specialText = cfg.special
      ? `；${cfg.specialLabel}平均命中 ${result.avgSpecial} 个（理论 ${result.expectedSpecial} 个）`
      : "";
    resultBox.innerHTML = `
      <div class="lab-result-head"><b>${E.STRATEGIES[state.strategy].name} · 最近 ${result.sample} 期</b><span>每期仅用此前数据生成 1 注</span></div>
      <div class="lab-compare">
        <div class="lab-stat"><span>策略平均命中 · ${mainDisplay}</span><strong>${result.avgMain}</strong><em>理论 ${result.expectedMain}</em><div class="lab-track"><i style="width:${mainWidth}%"></i></div></div>
        <div class="lab-stat is-theory"><span>纯随机理论期望 · ${mainDisplay}</span><strong>${result.expectedMain}</strong><em>数学期望值</em><div class="lab-track"><i style="width:${theoryWidth}%"></i></div></div>
        ${specialBlock}
      </div>
      <div class="lab-verdict"><i></i><span>策略平均命中 ${result.avgMain} 个（理论 ${result.expectedMain} 个）${specialText}。差异 ${diffText}，${direction}。在 ${result.sample} 期样本里，这属于正常随机波动，不能说明统计选号提高了中奖率。</span></div>
      <div class="lab-best">样本最高：第 ${result.best.issue} 期命中 ${mainDisplay} <b>${result.best.mainHits}</b> 个${cfg.special ? `，${cfg.specialLabel} <b>${result.best.specialHits}</b> 个` : ""} · 回测口径：${labels}。</div>
    `;
  }

  function runBacktest() {
    if (backtestBusy) return;
    const button = $("#btn-backtest");
    const resultBox = $("#lab-result");
    if (!button || !resultBox) return;
    backtestBusy = true;
    button.disabled = true;
    button.innerHTML = `回测中 <span class="spinner" style="width:12px;height:12px;border-width:1px"></span>`;
    resultBox.innerHTML = `<div class="lab-loading"><span class="spinner"></span><span>正在用历史数据逐期推演…</span></div>`;
    window.setTimeout(() => {
      try {
        const result = E.backtest({
          game: state.game,
          draws: drawsOf(),
          strategy: state.strategy,
          windowSize: state.windowSize,
          filters: state.filters,
          pick: state.pick,
          sample: 60,
        });
        renderBacktest(result);
      } catch (error) {
        console.error(error);
        resultBox.innerHTML = `<div class="lab-placeholder"><p>回测失败：${error?.message || "未知错误"}</p><small>请尝试更换统计样本或清除杀号。</small></div>`;
        toast("回测失败，请稍后再试");
      } finally {
        backtestBusy = false;
        button.disabled = false;
        button.innerHTML = `运行 60 期回测 <span aria-hidden="true">→</span>`;
      }
    }, 60);
  }

  /* ------------------------------- Export image ---------------------------- */
  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawExportBall(ctx, x, y, radius, kind, label) {
    const palettes = {
      red: ["#ffb0a4", "#dc5044", "#761813"],
      blue: ["#c3d7ff", "#5d86d8", "#183366"],
      gold: ["#fff0c2", "#dfb663", "#75501a"],
    };
    const colors = palettes[kind] || palettes.red;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    const gradient = ctx.createRadialGradient(x - radius * 0.32, y - radius * 0.38, radius * 0.08, x, y, radius);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(0.38, colors[1]);
    gradient.addColorStop(1, colors[2]);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, radius - 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = kind === "gold" ? "#2a1b08" : "rgba(255,250,242,0.98)";
    ctx.font = `600 ${Math.round(radius * 0.72)}px "Bahnschrift","Microsoft YaHei",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 1);
    ctx.restore();
  }

  function buildExportCanvas() {
    const result = state.results[state.game];
    if (!result) throw new Error("暂无可导出的号码");
    const cfg = E.GAMES[state.game];
    const issue = nextIssue();
    const W = 1080;
    const H = 1350;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0b0e15");
    bg.addColorStop(0.45, "#070a10");
    bg.addColorStop(1, "#05070b");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(540, 180, 20, 540, 180, 620);
    glow.addColorStop(0, "rgba(216,184,108,0.14)");
    glow.addColorStop(0.55, "rgba(216,184,108,0.03)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const lowerGlow = ctx.createRadialGradient(850, 1120, 20, 850, 1120, 420);
    lowerGlow.addColorStop(0, "rgba(226,96,82,0.06)");
    lowerGlow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = lowerGlow;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(216,184,108,0.26)";
    ctx.lineWidth = 1;
    ctx.strokeRect(48.5, 48.5, W - 97, H - 97);
    ctx.strokeStyle = "rgba(216,184,108,0.09)";
    ctx.strokeRect(58.5, 58.5, W - 117, H - 117);

    ctx.strokeStyle = "rgba(216,184,108,0.55)";
    ctx.lineWidth = 1.2;
    const corners = [
      [48, 88, 48, 48, 88, 48],
      [W - 88, 48, W - 48, 48, W - 48, 88],
      [48, H - 88, 48, H - 48, 88, H - 48],
      [W - 88, H - 48, W - 48, H - 48, W - 48, H - 88],
    ];
    for (const c of corners) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(c[2], c[3]);
      ctx.lineTo(c[4], c[5]);
      ctx.stroke();
    }

    // 印章
    ctx.save();
    ctx.strokeStyle = "rgba(216,184,108,0.55)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(100, 106, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(216,184,108,0.2)";
    ctx.beginPath();
    ctx.arc(100, 106, 23, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#f1dfae";
    ctx.font = '500 28px "STKaiti","KaiTi","Microsoft YaHei",serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("天", 100, 108);
    ctx.restore();

    ctx.textAlign = "left";
    ctx.fillStyle = "#f1dfae";
    ctx.font = '500 31px "STKaiti","KaiTi","Microsoft YaHei",serif';
    ctx.fillText("天机三彩", 148, 105);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = '9px "Bahnschrift","Consolas",sans-serif';
    ctx.fillText("L O T T E R Y   O R A C L E   ·   S T A T I S T I C A L   P I C K", 149, 128);

    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = '11px "Bahnschrift","Microsoft YaHei",sans-serif';
    const now = new Date();
    ctx.fillText(`${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}  ${pad2(now.getHours())}:${pad2(now.getMinutes())}`, W - 76, 100);
    ctx.fillStyle = "rgba(216,184,108,0.65)";
    ctx.font = '8px "Bahnschrift","Consolas",sans-serif';
    ctx.fillText("ORACLE TICKET · NO." + issue, W - 76, 120);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(76, 160);
    ctx.lineTo(W - 76, 160);
    ctx.stroke();

    const titleGradient = ctx.createLinearGradient(0, 196, 0, 246);
    titleGradient.addColorStop(0, "#fff2cd");
    titleGradient.addColorStop(0.55, "#ead49a");
    titleGradient.addColorStop(1, "#b48d45");
    ctx.textAlign = "left";
    ctx.fillStyle = titleGradient;
    ctx.font = '500 46px "STKaiti","KaiTi","Microsoft YaHei",serif';
    ctx.fillText(cfg.name, 80, 232);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = '11px "Microsoft YaHei","PingFang SC",sans-serif';
    ctx.fillText(cfg.description, 82, 257);

    ctx.textAlign = "right";
    ctx.fillStyle = "#f1dfae";
    ctx.font = '16px "Bahnschrift","Microsoft YaHei",sans-serif';
    ctx.fillText(`第 ${issue} 期`, W - 80, 220);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = '10px "Microsoft YaHei",sans-serif';
    ctx.fillText(`${result.meta.strategyName} · 生成于 ${formatTime(result.meta.generatedAt)}`, W - 80, 242);

    ctx.textAlign = "left";
    roundRectPath(ctx, 80, 278, 168, 24, 12);
    ctx.fillStyle = "rgba(216,184,108,0.07)";
    ctx.fill();
    ctx.strokeStyle = "rgba(216,184,108,0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(241,223,174,0.75)";
    ctx.font = '9px "Microsoft YaHei",sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("统计选号 · 仅供娱乐", 164, 291);
    ctx.textBaseline = "alphabetic";

    const count = result.tickets.length;
    const rowH = Math.min(150, Math.max(78, Math.floor(720 / count)));
    const startY = 344;
    const ballRadius = count <= 2 ? 25 : count <= 5 ? 22 : 18;
    const ballGap = ballRadius * 2 + 10;
    for (let index = 0; index < count; index++) {
      const ticket = result.tickets[index];
      const y = startY + index * rowH;
      if (index > 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.055)";
        ctx.setLineDash([3, 7]);
        ctx.beginPath();
        ctx.moveTo(80, y - 6);
        ctx.lineTo(W - 80, y - 6);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const ballY = y + (rowH >= 100 ? 34 : rowH / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "rgba(216,184,108,0.8)";
      ctx.font = '500 15px "STKaiti","KaiTi",serif';
      ctx.fillText(CN_DIGITS[index + 1] || String(index + 1), 80, ballY + 4);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = '7px "Bahnschrift",sans-serif';
      ctx.fillText(pad2(index + 1), 81, ballY + 20);

      let bx = 130;
      ticket.main.forEach((n) => {
        drawExportBall(ctx, bx + ballRadius, ballY, ballRadius, cfg.special ? "red" : "gold", pad2(n));
        bx += ballGap;
      });
      if (cfg.special && ticket.special?.length) {
        ctx.fillStyle = "rgba(216,184,108,0.55)";
        ctx.font = '16px "Bahnschrift",sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("+", bx + 3, ballY);
        bx += 24;
        ticket.special.forEach((n) => {
          drawExportBall(ctx, bx + ballRadius, ballY, ballRadius, "blue", pad2(n));
          bx += ballGap;
        });
      }

      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#f1dfae";
      ctx.font = '500 28px "Bahnschrift",sans-serif';
      ctx.fillText(String(Math.round(ticket.score)), W - 84, ballY + 4);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = '8px "Microsoft YaHei",sans-serif';
      ctx.fillText("结构分", W - 84, ballY + 20);

      if (rowH >= 100) {
        const tagY = ballY + ballRadius + 22;
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(255,255,255,0.38)";
        ctx.font = '9px "Microsoft YaHei",sans-serif';
        const tags = [
          `和值 ${ticket.metrics.sum}`,
          `奇偶 ${ticket.metrics.oddEven}`,
          `大小 ${ticket.metrics.sizeRatio}`,
          `三区 ${ticket.metrics.zoneRatio}`,
          `连号 ${ticket.metrics.consecutiveGroups ? `${ticket.metrics.consecutiveGroups}组` : "无"}`,
          `跨度 ${ticket.metrics.span}`,
        ];
        ctx.fillText(tags.join("    ·    "), 130, tagY);
      }
    }

    if (count < 4) {
      const centerY = 850;
      ctx.save();
      ctx.strokeStyle = "rgba(216,184,108,0.10)";
      ctx.lineWidth = 1;
      for (const radius of [230, 190, 150]) {
        ctx.beginPath();
        ctx.arc(W / 2, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(216,184,108,0.035)";
      ctx.font = '500 210px "STKaiti","KaiTi",serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("机", W / 2, centerY + 8);
      ctx.restore();
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(241,223,174,0.7)";
      ctx.font = '500 23px "STKaiti","KaiTi",serif';
      const line = ORACLE_LINES[(sum(result.tickets[0].main) + sum(result.tickets[0].special || [])) % ORACLE_LINES.length];
      ctx.fillText(`「${line}」`, W / 2, centerY + 300);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = '9px "Bahnschrift","Microsoft YaHei",sans-serif';
      ctx.fillText("天 机 三 彩   ·   结 构 选 号 签", W / 2, centerY + 326);
    }

    ctx.textAlign = "left";
    ctx.strokeStyle = "rgba(216,184,108,0.2)";
    ctx.beginPath();
    ctx.moveTo(80, H - 148);
    ctx.lineTo(W - 80, H - 148);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = '11px "Microsoft YaHei","PingFang SC",sans-serif';
    ctx.fillText("本图由「天机三彩」基于历史开奖统计生成，仅作娱乐参考，不构成投注建议。", 80, H - 112);
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = '9px "Microsoft YaHei",sans-serif';
    ctx.fillText("彩票开奖为独立随机事件，任何统计选号都不能提高中奖概率。理性购彩，量力而行，未满 18 周岁禁止购彩。", 80, H - 92);
    ctx.fillStyle = "rgba(216,184,108,0.45)";
    ctx.font = '8px "Bahnschrift","Microsoft YaHei",sans-serif';
    ctx.fillText(`DATA · ${DATA.meta.asOf}   |   SOURCE · 中国福利彩票官网 / 500彩票网   |   SANCAI ORACLE`, 80, H - 72);

    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(216,184,108,0.22)";
    ctx.font = '500 22px "STKaiti","KaiTi",serif';
    ctx.fillText("天机", W - 100, H - 80);
    ctx.strokeStyle = "rgba(216,184,108,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(W - 100, H - 88, 25, 0, Math.PI * 2);
    ctx.stroke();

    return canvas;
  }

  function downloadImage() {
    try {
      const canvas = buildExportCanvas();
      canvas.toBlob((blob) => {
        if (!blob) {
          toast("图片生成失败，请稍后再试");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `天机三彩_${E.GAMES[state.game].short}_${nextIssue()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("号码图片已生成");
      }, "image/png");
    } catch (error) {
      console.error(error);
      toast(error?.message || "图片生成失败");
    }
  }

  /* --------------------------------- Sky ---------------------------------- */
  function startSky() {
    const canvas = $("#sky");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let width = 0;
    let height = 0;
    let dpr = 1;
    let stars = [];
    let dust = [];
    let raf = 0;

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: 90 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.1 + 0.25,
        alpha: Math.random() * 0.45 + 0.12,
        speed: Math.random() * 0.07 + 0.015,
        phase: Math.random() * Math.PI * 2,
      }));
      dust = Array.from({ length: 20 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.6 + 0.5,
        alpha: Math.random() * 0.2 + 0.04,
        speed: Math.random() * 0.12 + 0.03,
        phase: Math.random() * Math.PI * 2,
      }));
      draw(performance.now(), false);
    }

    function draw(time, animate) {
      ctx.clearRect(0, 0, width, height);
      for (const star of stars) {
        const twinkle = 0.68 + Math.sin(time * 0.001 + star.phase) * 0.32;
        ctx.beginPath();
        ctx.fillStyle = `rgba(236,229,208,${star.alpha * twinkle})`;
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
        if (animate) {
          star.y += star.speed;
          if (star.y > height + 2) {
            star.y = -2;
            star.x = Math.random() * width;
          }
        }
      }
      for (const particle of dust) {
        const twinkle = 0.6 + Math.sin(time * 0.0006 + particle.phase) * 0.4;
        ctx.beginPath();
        ctx.fillStyle = `rgba(216,184,108,${particle.alpha * twinkle})`;
        ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        ctx.fill();
        if (animate) {
          particle.y -= particle.speed;
          particle.x += Math.sin(time * 0.0004 + particle.phase) * 0.06;
          if (particle.y < -4) {
            particle.y = height + 4;
            particle.x = Math.random() * width;
          }
        }
      }
    }

    function loop(time) {
      draw(time, true);
      raf = requestAnimationFrame(loop);
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });
    if (!REDUCED_MOTION) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (!REDUCED_MOTION) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      }
    });
  }

  /* --------------------------------- Clock --------------------------------- */
  function updateClock() {
    const now = new Date();
    const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const date = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())} ${WEEKDAYS[now.getDay()]}`;
    const timeEl = $("#clock-time");
    const dateEl = $("#clock-date");
    if (timeEl) timeEl.textContent = time;
    if (dateEl) dateEl.textContent = date;
  }

  /* -------------------------------- Events --------------------------------- */
  function bindEvents() {
    $("#game-nav")?.addEventListener("click", (event) => {
      const button = event.target.closest(".game-tab");
      if (!button || state.busy) return;
      if (button.dataset.game === state.game) return;
      activateGame(button.dataset.game);
    });

    $("#strategy-list")?.addEventListener("click", (event) => {
      const button = event.target.closest(".strategy-item");
      if (!button) return;
      const strategy = button.dataset.strategy;
      if (!strategy || state.strategy === strategy) return;
      state.strategy = strategy;
      renderStrategyState();
      updateLabLabel();
      persistSettings();
      if (state.game) requestGenerate(150);
    });

    $("#pick-chips")?.addEventListener("click", (event) => {
      const button = event.target.closest(".pick-chip");
      if (!button) return;
      const pick = Number(button.dataset.pick);
      if (!Number.isInteger(pick) || pick === state.pick) return;
      state.pick = pick;
      renderPickChips();
      persistSettings();
      requestGenerate(140);
    });

    $$("[data-count-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const step = Number(button.dataset.countStep);
        state.count = clamp(state.count + step, 1, 10);
        $("#count-value").textContent = String(state.count);
        updateCountTicks();
        persistSettings();
        requestGenerate(120);
      });
    });

    $("#window-select")?.addEventListener("change", (event) => {
      const select = event.target;
      const value = Number(select.value);
      state.windowSize = value;
      updateFoot();
      persistSettings();
      requestGenerate(120);
    });

    $("#filter-toggles")?.addEventListener("change", (event) => {
      const input = event.target.closest("input[data-filter]");
      if (!input) return;
      state.filters[input.dataset.filter] = input.checked;
      persistSettings();
      requestGenerate(180);
    });

    $("#reset-filters")?.addEventListener("click", () => {
      for (const key of Object.keys(state.filters)) state.filters[key] = true;
      renderFilters();
      persistSettings();
      requestGenerate(120);
      toast("结构过滤已恢复默认");
    });

    $("#btn-generate")?.addEventListener("click", () => {
      requestGenerate(0, true);
    });
    $("#btn-regenerate")?.addEventListener("click", () => {
      if (state.busy) return;
      requestGenerate(0, true);
    });

    $("#btn-copy")?.addEventListener("click", () => copyPlain(currentText()));
    $("#btn-save")?.addEventListener("click", saveCurrent);
    $("#btn-export")?.addEventListener("click", downloadImage);

    $("#ticket-area")?.addEventListener("click", (event) => {
      const ticket = event.target.closest(".ticket");
      if (!ticket) return;
      selectTicket(Number(ticket.dataset.index));
    });
    $("#ticket-area")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const ticket = event.target.closest(".ticket");
      if (!ticket) return;
      event.preventDefault();
      selectTicket(Number(ticket.dataset.index));
    });

    $("#heatmap")?.addEventListener("click", (event) => {
      const cell = event.target.closest(".heat-cell");
      if (!cell) return;
      toggleExclude(cell.dataset.zone, Number(cell.dataset.n));
    });

    $("#excluded-box")?.addEventListener("click", (event) => {
      const chip = event.target.closest(".excluded-chip");
      if (!chip) return;
      removeExclude(chip.dataset.zone, Number(chip.dataset.n));
    });

    $("#clear-excluded")?.addEventListener("click", () => {
      const gameExcluded = state.excluded[state.game];
      for (const key of Object.keys(gameExcluded)) gameExcluded[key].clear();
      renderExcluded();
      renderHeatmap();
      toast("杀号已清空");
    });

    $("#trend-tabs")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-metric]");
      if (!button) return;
      const metric = button.dataset.metric;
      if (!TREND_LABELS[metric]) return;
      state.trendMetric = metric;
      renderTrend();
    });

    const chart = $("#trend-chart");
    chart?.addEventListener("pointermove", onTrendMove);
    chart?.addEventListener("pointerleave", hideTrendTip);

    $("#btn-more-history")?.addEventListener("click", () => {
      const all = drawsOf().length;
      const next = HISTORY_STEPS.find((step) => step > state.historyRows);
      state.historyRows = next ? Math.min(next, all, 100) : Math.min(100, all);
      renderHistory();
    });

    $("#btn-probability")?.addEventListener("click", openProbability);
    $("#btn-insight-probability")?.addEventListener("click", openProbability);
    $("#btn-about")?.addEventListener("click", openAbout);
    $("#btn-saved")?.addEventListener("click", openDrawer);
    $("#btn-backtest")?.addEventListener("click", runBacktest);
    $("#btn-clear-saved")?.addEventListener("click", () => {
      if (!state.saved.length) {
        toast("收藏夹已经是空的");
        return;
      }
      if (!window.confirm("确定清空全部收藏号码吗？此操作不可恢复。")) return;
      state.saved = [];
      persistSaved();
      renderSavedList();
      toast("收藏已清空");
    });

    $("#saved-list")?.addEventListener("click", (event) => {
      const copyButton = event.target.closest("[data-saved-copy]");
      if (copyButton) {
        const item = state.saved.find((entry) => entry.id === copyButton.dataset.savedCopy);
        if (item) copyPlain(savedText(item));
        return;
      }
      const deleteButton = event.target.closest("[data-saved-del]");
      if (deleteButton) {
        state.saved = state.saved.filter((entry) => entry.id !== deleteButton.dataset.savedDel);
        persistSaved();
        renderSavedList();
        toast("已移除这注收藏");
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const closeModalButton = target.closest("[data-close-modal]");
      if (closeModalButton) {
        closeModal(closeModalButton.closest(".modal"));
        return;
      }
      const closeDrawerButton = target.closest("[data-close-drawer]");
      if (closeDrawerButton) closeDrawer();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const openModalEl = $(".modal.is-open");
        if (openModalEl) closeModal(openModalEl);
        else closeDrawer();
      }
    });

    window.addEventListener(
      "resize",
      () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          renderTrend();
        }, 180);
      },
      { passive: true }
    );
  }

  function updateCountTicks() {
    const ticks = $$(".count-ticks i");
    ticks.forEach((tick, index) => tick.classList.toggle("is-on", index < state.count));
  }

  function toggleExclude(zone, n) {
    if (!Number.isInteger(n)) return;
    const gameExcluded = state.excluded[state.game];
    if (!gameExcluded[zone]) return;
    const zoneConfig = zonesOf().find((item) => item.key === zone);
    if (!zoneConfig) return;
    if (gameExcluded[zone].has(n)) {
      gameExcluded[zone].delete(n);
      renderExcluded();
      renderHeatmap();
      return;
    }
    const selectedCount = zoneConfig.pick;
    const maxExcluded = zoneConfig.max - selectedCount;
    if (gameExcluded[zone].size >= maxExcluded) {
      toast(`杀号过多：该区至少需要保留 ${selectedCount} 个可选号码`);
      return;
    }
    gameExcluded[zone].add(n);
    renderExcluded();
    renderHeatmap();
    toast(`已杀号 ${pad2(n)} · 点击「天机推演」应用`);
  }

  function removeExclude(zone, n) {
    const gameExcluded = state.excluded[state.game];
    if (!gameExcluded[zone]) return;
    gameExcluded[zone].delete(n);
    renderExcluded();
    renderHeatmap();
  }

  /* --------------------------------- Init ---------------------------------- */
  function renderFooterMeta() {
    $("#footer-asof").textContent = DATA.meta.asOf;
    const dlt = DATA.meta.games.dlt;
    const ssq = DATA.meta.games.ssq;
    const kl8 = DATA.meta.games.kl8;
    const dltEl = $("#about-dlt");
    const ssqEl = $("#about-ssq");
    const kl8El = $("#about-kl8");
    if (dltEl) dltEl.textContent = `${dlt.drawCount} 期 · ${dlt.first.date} → ${dlt.last.date}`;
    if (ssqEl) ssqEl.textContent = `${ssq.drawCount} 期 · ${ssq.first.date} → ${ssq.last.date}`;
    if (kl8El) kl8El.textContent = `${kl8.drawCount} 期 · ${kl8.first.date} → ${kl8.last.date}`;
  }

  function init() {
    try {
      if (!DATA?.games || !E) throw new Error("数据或引擎未加载");
      for (const key of ["dlt", "ssq", "kl8"]) {
        if (!DATA.games[key]?.draws?.length) throw new Error(`缺少 ${key} 历史数据`);
        if (DATA.games[key].draws.length < 80) throw new Error(`${key} 数据样本不足`);
      }
      if (!E.GAMES || !E.STRATEGIES) throw new Error("选号引擎未就绪");

      loadSettings();
      state.saved = loadSaved();
      document.documentElement.dataset.game = state.game;
      updateNav();
      renderStrategies();
      renderPickChips();
      renderFilters();
      renderFooterMeta();
      updateCountTicks();
      updateSavedBadge();
      bindEvents();
      updateClock();
      window.setInterval(updateClock, 1000);
      window.setInterval(renderCountdown, 60000);
      startSky();
      activateGame(state.game, { initial: true });
      state.ready = true;
      document.documentElement.dataset.ready = "1";
      window.setTimeout(hideBoot, 620);
      document.title = `${E.GAMES[state.game].name} · 天机三彩`;

      window.__APP__ = {
        get ready() {
          return state.ready;
        },
        get busy() {
          return state.busy;
        },
        state,
        activateGame,
        generate: () => requestGenerate(0, true),
        runBacktest,
        buildExportCanvas,
        openProbability,
        openDrawer,
        getStats,
        nextIssue,
        currentText,
      };
    } catch (error) {
      console.error(error);
      document.documentElement.dataset.ready = "error";
      showBootError(`启动失败：${error?.message || "未知错误"}\n请检查 js/data.js 与 js/engine.js 是否完整。`);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.addEventListener("error", (event) => {
    console.error("页面错误:", event.error || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("未处理的 Promise 错误:", event.reason);
  });
})();
