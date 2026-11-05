/**
 * 天机三彩 · 统计选号引擎
 * ------------------------------------------------------------
 * 这是一个“结构选号”引擎，不是中奖预言机。
 * 它基于给定历史开奖，计算频率、遗漏、关联等统计特征，
 * 再按不同审美/策略生成号码，并给出结构评分。
 * 彩票每期独立随机，任何统计都无法改变中奖概率。
 *
 * 无依赖、可在浏览器与 Node 中运行。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SancaiEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PHI = 0.6180339887498949;

  const GAMES = {
    dlt: {
      key: "dlt",
      name: "超级大乐透",
      en: "SUPER LOTTO",
      short: "大乐透",
      mainLabel: "前区",
      specialLabel: "后区",
      main: { max: 35, pick: 5, observed: 5 },
      special: { max: 12, pick: 2, observed: 2 },
      drawDays: [1, 3, 6],
      drawTime: "21:25",
      odds: 21425712,
      oddsText: "1 / 21,425,712",
      prizeNote: "头奖：前区 5 + 后区 2",
      description: "前区 35 选 5，后区 12 选 2",
    },
    ssq: {
      key: "ssq",
      name: "双色球",
      en: "DOUBLE COLOR BALL",
      short: "双色球",
      mainLabel: "红球",
      specialLabel: "蓝球",
      main: { max: 33, pick: 6, observed: 6 },
      special: { max: 16, pick: 1, observed: 1 },
      drawDays: [0, 2, 4],
      drawTime: "21:15",
      odds: 17721088,
      oddsText: "1 / 17,721,088",
      prizeNote: "头奖：红球 6 + 蓝球 1",
      description: "红球 33 选 6，蓝球 16 选 1",
    },
    kl8: {
      key: "kl8",
      name: "快乐8",
      en: "HAPPY 8",
      short: "快乐8",
      mainLabel: "选号",
      specialLabel: "",
      main: { max: 80, pick: 10, observed: 20 },
      special: null,
      drawDays: [0, 1, 2, 3, 4, 5, 6],
      drawTime: "21:30",
      odds: 8911711,
      oddsText: "1 / 8,911,711",
      prizeNote: "选十中十",
      description: "80 选 10 · 每期开出 20 个号码",
    },
  };

  const STRATEGIES = {
    balanced: { key: "balanced", name: "天机均衡", en: "BALANCE", desc: "冷热、遗漏、关联多维平衡" },
    hot: { key: "hot", name: "热号追击", en: "HOT TRACK", desc: "跟随近期高频与活跃号码" },
    cold: { key: "cold", name: "冷号回补", en: "COLD RETURN", desc: "关注长期缺席的遗漏号码" },
    golden: { key: "golden", name: "黄金分割", en: "GOLDEN RATIO", desc: "按黄金比例在区间内错落分布" },
    markov: { key: "markov", name: "关联共振", en: "SYNERGY", desc: "基于共现关系寻找上期关联号" },
    random: { key: "random", name: "随机漫步", en: "RANDOM", desc: "纯随机，作为概率对照组" },
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const average = (arr) => (arr.length ? sum(arr) / arr.length : 0);
  const round = (value, digits = 1) => {
    const p = Math.pow(10, digits);
    return Math.round(value * p) / p;
  };
  const intersectionCount = (a, b) => {
    const set = new Set(a);
    return b.reduce((count, n) => count + (set.has(n) ? 1 : 0), 0);
  };

  /** mulberry32：轻量、可复现的伪随机数生成器 */
  function makeRng(seed) {
    let a = (Number(seed) || 0) >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeSeed(input) {
    const str = String(input ?? Date.now());
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function getPickOptions(game) {
    if (game === "kl8") return [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    return [GAMES[game].main.pick];
  }

  function getPickCount(game, requested) {
    if (game === "kl8") return clamp(Math.round(Number(requested) || 10), 1, 10);
    return GAMES[game].main.pick;
  }

  function zoneOf(n, max, parts = 3) {
    return Math.min(parts - 1, Math.floor(((n - 1) * parts) / max));
  }

  function consecutiveGroups(numbers) {
    if (!numbers.length) return 0;
    let groups = 0;
    let run = 1;
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] === numbers[i - 1] + 1) {
        run++;
      } else {
        if (run >= 2) groups++;
        run = 1;
      }
    }
    if (run >= 2) groups++;
    return groups;
  }

  function acValue(numbers) {
    const diffs = new Set();
    for (let i = 0; i < numbers.length; i++) {
      for (let j = i + 1; j < numbers.length; j++) {
        diffs.add(Math.abs(numbers[j] - numbers[i]));
      }
    }
    return Math.max(0, diffs.size - (numbers.length - 1));
  }

  function metricsOf(numbers, max) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const odd = sorted.filter((n) => n % 2 === 1).length;
    const bigSplit = max / 2;
    const big = sorted.filter((n) => n > bigSplit).length;
    const zones = [0, 0, 0];
    for (const n of sorted) zones[zoneOf(n, max)]++;
    return {
      sum: sum(sorted),
      odd,
      even: sorted.length - odd,
      big,
      small: sorted.length - big,
      span: sorted.length ? sorted[sorted.length - 1] - sorted[0] : 0,
      ac: acValue(sorted),
      consecutiveGroups: consecutiveGroups(sorted),
      zones,
      oddEven: `${odd}:${sorted.length - odd}`,
      sizeRatio: `${big}:${sorted.length - big}`,
      zoneRatio: zones.join(":"),
      count: sorted.length,
    };
  }

  /** 理论均值 / 标准差：从 max 个号码中不放回抽取 pick 个 */
  function analyticSum(max, pick) {
    const mean = (pick * (max + 1)) / 2;
    const variance = ((pick * (max * max - 1)) / 12) * ((max - pick) / Math.max(1, max - 1));
    return { mean, sd: Math.sqrt(Math.max(0.0001, variance)) };
  }

  function computeZone(zoneCfg, window, selector, latestNumbers) {
    const max = zoneCfg.max;
    const observed = zoneCfg.observed;
    const size = window.length;
    const p = observed / max;
    const expected = size * p;
    const sd = Math.sqrt(Math.max(0.25, size * p * (1 - p)));
    const freq = new Array(max + 1).fill(0);
    const recent = new Array(max + 1).fill(0);
    const omission = new Array(max + 1).fill(size);
    const pair = new Float64Array((max + 1) * (max + 1));

    window.forEach((draw, index) => {
      const nums = selector(draw) || [];
      for (const n of nums) {
        if (n >= 1 && n <= max) {
          freq[n]++;
          if (index >= size - 10) recent[n]++;
        }
      }
      for (let i = 0; i < nums.length; i++) {
        for (let j = i + 1; j < nums.length; j++) {
          const a = nums[i];
          const b = nums[j];
          if (a >= 1 && a <= max && b >= 1 && b <= max && a !== b) {
            pair[a * (max + 1) + b]++;
            pair[b * (max + 1) + a]++;
          }
        }
      }
    });

    for (let i = size - 1; i >= 0; i--) {
      const nums = selector(window[i]) || [];
      for (const n of nums) {
        if (omission[n] === size) omission[n] = size - 1 - i;
      }
    }

    const latestSet = new Set(latestNumbers);
    const rawSynergy = new Array(max + 1).fill(0);
    let maxSynergy = 0;
    for (let n = 1; n <= max; n++) {
      let total = 0;
      let count = 0;
      for (const m of latestNumbers) {
        if (m === n) continue;
        total += pair[n * (max + 1) + m];
        count++;
      }
      rawSynergy[n] = count ? total / count : 0;
      if (rawSynergy[n] > maxSynergy) maxSynergy = rawSynergy[n];
    }

    const expectedGap = max / observed;
    const recentExpected = 10 * p;
    const recentSd = Math.sqrt(Math.max(0.2, 10 * p * (1 - p)));
    const list = [];
    for (let n = 1; n <= max; n++) {
      const z = (freq[n] - expected) / sd;
      const heat = clamp(0.5 + z * 0.18, 0.04, 0.96);
      const overdue = clamp(omission[n] / Math.max(2, expectedGap * 2.5), 0, 1);
      const recentNorm = clamp(0.5 + ((recent[n] - recentExpected) / recentSd) * 0.22, 0, 1);
      const synergy = maxSynergy > 0 ? rawSynergy[n] / maxSynergy : 0;
      list.push({
        n,
        freq: freq[n],
        freqPct: size ? (freq[n] / size) * 100 : 0,
        z: round(z, 2),
        heat: round(heat, 4),
        omission: omission[n],
        overdue: round(overdue, 4),
        recent: recent[n],
        recentNorm: round(recentNorm, 4),
        synergy: round(synergy, 4),
        isLatest: latestSet.has(n),
        zone: zoneOf(n, max),
      });
    }
    const hotRanked = [...list].sort((a, b) => b.freq - a.freq || a.n - b.n);
    const coldRanked = [...list].sort((a, b) => b.omission - a.omission || a.freq - b.freq || a.n - b.n);
    hotRanked.forEach((item, index) => (item.hotRank = index + 1));
    coldRanked.forEach((item, index) => (item.coldRank = index + 1));

    return {
      max,
      observed,
      pick: zoneCfg.pick,
      windowSize: size,
      expected: round(expected, 2),
      sd: round(sd, 2),
      latestNumbers: [...latestNumbers],
      list,
      hotRanked,
      coldRanked,
      meanFreq: round(expected, 2),
    };
  }

  function computeStructural(window, cfg) {
    const sums = window.map((d) => sum(d.main));
    const spans = window.map((d) => {
      const sorted = [...d.main].sort((a, b) => a - b);
      return sorted[sorted.length - 1] - sorted[0];
    });
    const oddCounts = window.map((d) => d.main.filter((n) => n % 2 === 1).length);
    const repeats = [];
    for (let i = 1; i < window.length; i++) {
      repeats.push(intersectionCount(window[i - 1].main, window[i].main));
    }
    const meanSum = average(sums);
    const stdSum = Math.sqrt(average(sums.map((v) => (v - meanSum) ** 2))) || 1;
    const zoneTotals = [0, 0, 0];
    for (const draw of window) {
      for (const n of draw.main) zoneTotals[zoneOf(n, cfg.main.max)]++;
    }
    return {
      sums,
      spans,
      oddCounts,
      repeats,
      meanSum: round(meanSum, 2),
      stdSum: round(stdSum, 2),
      meanSpan: round(average(spans), 2),
      meanOdd: round(average(oddCounts), 2),
      repeatAvg: round(average(repeats), 2),
      zoneTotals,
    };
  }

  /**
   * 计算统计底稿
   * @param {string} game dlt|ssq|kl8
   * @param {Array} draws 历史开奖（升序）
   * @param {number} windowSize 统计窗口；0/空 表示全部
   */
  function prepare(game, draws, windowSize) {
    const cfg = GAMES[game];
    if (!cfg) throw new Error("未知彩种：" + game);
    if (!Array.isArray(draws) || draws.length === 0) throw new Error("没有可用的历史数据");
    const requested = Number(windowSize);
    const size = Math.max(10, Math.min(requested > 0 ? requested : draws.length, draws.length));
    const window = draws.slice(-size);
    const latest = window[window.length - 1];
    const main = computeZone(cfg.main, window, (d) => d.main, latest.main);
    const special = cfg.special
      ? computeZone(cfg.special, window, (d) => d.special || [], latest.special || [])
      : null;
    return {
      game,
      cfg,
      window,
      latest,
      windowSize: window.length,
      main,
      special,
      structural: computeStructural(window, cfg),
    };
  }

  function strategyWeight(item, strategy, rng, extra = {}) {
    const heat = item.heat;
    const overdue = item.overdue;
    const synergy = item.synergy;
    const recent = item.recentNorm;
    const jitter = rng() * 0.14;
    switch (strategy) {
      case "hot":
        return 0.25 + 2.6 * Math.pow(heat, 1.6) + 0.55 * recent + jitter;
      case "cold":
        return 0.25 + 2.8 * overdue + 0.9 * (1 - heat) + jitter;
      case "markov":
        return 0.25 + 2.9 * synergy + 0.7 * heat + 0.2 * recent + jitter;
      case "golden": {
        const distance = Math.abs(item.n - extra.target);
        const sigma = extra.sigma || 4;
        return 0.03 + Math.exp(-0.5 * (distance / sigma) ** 2) + 0.08 * heat + jitter * 0.3;
      }
      case "random":
        return 1;
      case "balanced":
      default:
        return (
          0.35 +
          0.85 * (1 - Math.abs(heat - 0.5) * 2) +
          0.9 * overdue * (1 - overdue * 0.55) +
          0.35 * recent +
          0.3 * synergy +
          jitter
        );
    }
  }

  function weightedSample(weights, count, rng) {
    const work = weights.map((w) => Math.max(0, w));
    const picked = [];
    for (let k = 0; k < count; k++) {
      let total = 0;
      for (let i = 1; i < work.length; i++) total += work[i];
      if (total <= 0) {
        for (let i = 1; i < work.length && picked.length < count; i++) {
          if (work[i] > 0 || weights[i] > 0) {
            picked.push(i);
            work[i] = 0;
          }
        }
        break;
      }
      let r = rng() * total;
      let chosen = 1;
      for (let i = 1; i < work.length; i++) {
        r -= work[i];
        if (r <= 0 && work[i] > 0) {
          chosen = i;
          break;
        }
      }
      if (work[chosen] <= 0) {
        for (let i = 1; i < work.length; i++) {
          if (work[i] > 0) {
            chosen = i;
            break;
          }
        }
      }
      picked.push(chosen);
      work[chosen] = 0;
    }
    return picked.sort((a, b) => a - b);
  }

  function buildGoldenTargets(max, pick, rng) {
    const phase = rng();
    const targets = [];
    for (let i = 0; i < pick; i++) {
      const fraction = (phase + (i + 1) * PHI) % 1;
      targets.push(1 + fraction * (max - 1));
    }
    return targets;
  }

  function sampleZone(zone, pickCount, strategy, rng, excludedSet) {
    if (!zone) return [];
    const available = [];
    for (let n = 1; n <= zone.max; n++) if (!excludedSet.has(n)) available.push(n);
    if (available.length < pickCount) {
      throw new Error("可杀号数量不足，请清除部分杀号后重试");
    }
    const targets = strategy === "golden" ? buildGoldenTargets(zone.max, pickCount, rng) : null;
    const sigma = Math.max(1.5, zone.max / Math.max(3, pickCount * 1.65));
    let guard = 0;
    while (guard++ < 80) {
      const weights = new Array(zone.max + 1).fill(0);
      for (const item of zone.list) {
        if (excludedSet.has(item.n)) continue;
        let target = 0;
        if (targets) {
          let best = Infinity;
          for (const t of targets) best = Math.min(best, Math.abs(item.n - t));
          target = best;
        }
        weights[item.n] = strategyWeight(item, strategy, rng, { target, sigma });
      }
      const picked = weightedSample(weights, pickCount, rng);
      if (picked.length === pickCount) return picked;
    }
    return available.slice(0, pickCount).sort((a, b) => a - b);
  }

  function scoreSet(numbers, stats, cfg, pick) {
    const max = cfg.main.max;
    const metrics = metricsOf(numbers, max);
    const theoretical = analyticSum(max, pick);
    const heatAvg = average(numbers.map((n) => stats.main.list[n - 1].heat));
    const oddTarget = pick / 2;
    const bigTarget = pick / 2;
    const heatScore = clamp(100 - Math.abs(heatAvg - 0.5) * 118, 35, 100);
    const oddScore = clamp(100 - Math.abs(metrics.odd - oddTarget) * (pick >= 8 ? 9 : 16), 20, 100);
    const sizeScore = clamp(100 - Math.abs(metrics.big - bigTarget) * (pick >= 8 ? 9 : 16), 20, 100);
    const sumScore = clamp(100 * Math.exp(-0.5 * ((metrics.sum - theoretical.mean) / theoretical.sd) ** 2), 10, 100);
    const occupied = metrics.zones.filter((v) => v > 0).length;
    const coverageScore = pick <= 2 ? 100 : clamp((occupied / 3) * 100, 20, 100);
    const consecutiveScore = clamp(100 - Math.max(0, metrics.consecutiveGroups - 1) * 22, 25, 100);
    const composite =
      heatScore * 0.18 +
      oddScore * 0.16 +
      sizeScore * 0.12 +
      sumScore * 0.22 +
      coverageScore * 0.2 +
      consecutiveScore * 0.12;
    return {
      score: round(composite, 1),
      subscores: {
        heat: round(heatScore, 1),
        odd: round(oddScore, 1),
        size: round(sizeScore, 1),
        sum: round(sumScore, 1),
        coverage: round(coverageScore, 1),
        consecutive: round(consecutiveScore, 1),
      },
      metrics,
      heatAvg: round(heatAvg, 4),
    };
  }

  function passesFilters(metrics, filters, pick, max) {
    if (!filters || pick < 4) return true;
    if (filters.odd) {
      const tolerance = Math.max(1, Math.round(pick * 0.18));
      if (Math.abs(metrics.odd - pick / 2) > tolerance) return false;
    }
    if (filters.size) {
      const tolerance = Math.max(1, Math.round(pick * 0.18));
      if (Math.abs(metrics.big - pick / 2) > tolerance) return false;
    }
    if (filters.sum) {
      const theoretical = analyticSum(max, pick);
      if (Math.abs(metrics.sum - theoretical.mean) > theoretical.sd * 1.45) return false;
    }
    if (filters.consecutive) {
      const maxGroups = pick >= 8 ? 2 : 1;
      if (metrics.consecutiveGroups > maxGroups) return false;
    }
    if (filters.coverage) {
      const occupied = metrics.zones.filter((v) => v > 0).length;
      const required = pick >= 5 ? 3 : 2;
      if (occupied < required) return false;
      if (metrics.zones.some((v) => v > pick * 0.62)) return false;
    }
    return true;
  }

  function objectiveOf(ticket, strategy) {
    switch (strategy) {
      case "hot":
        return ticket.main.reduce((acc, n, i) => acc + ticket.stats.main.list[n - 1].heat, 0) / ticket.main.length;
      case "cold":
        return ticket.main.reduce((acc, n) => acc + ticket.stats.main.list[n - 1].overdue, 0) / ticket.main.length;
      case "markov":
        return ticket.main.reduce((acc, n) => acc + ticket.stats.main.list[n - 1].synergy, 0) / ticket.main.length;
      default:
        return ticket.score;
    }
  }

  /**
   * 生成选号
   * @param {object} options
   * @param {string} options.game
   * @param {Array} options.draws
   * @param {string} options.strategy
   * @param {number} options.count
   * @param {number} options.windowSize
   * @param {object} options.filters
   * @param {object|Array} options.excluded {main:[], special:[]} 或主区数组
   * @param {number} options.seed
   * @param {number} options.pick 快乐8玩法选号个数
   */
  function generate(options) {
    const {
      game,
      draws,
      strategy = "balanced",
      count = 1,
      windowSize = 100,
      filters = { odd: true, size: true, sum: true, consecutive: true, coverage: true },
      excluded,
      seed = Date.now(),
      pick: requestedPick,
      attempts: requestedAttempts,
    } = options;
    const cfg = GAMES[game];
    if (!cfg) throw new Error("未知彩种：" + game);
    if (!STRATEGIES[strategy]) throw new Error("未知策略：" + strategy);
    if (!Array.isArray(draws) || draws.length < 20) throw new Error("历史数据不足，无法推演");
    const pick = getPickCount(game, requestedPick);
    const stats = prepare(game, draws, windowSize);
    const rng = makeRng(seed);
    const mainExcluded = new Set(Array.isArray(excluded) ? excluded : excluded?.main || []);
    const specialExcluded = new Set(Array.isArray(excluded) ? [] : excluded?.special || []);
    const tickets = [];
    const usedMain = new Set();
    let relaxed = 0;
    const baseAttempts = requestedAttempts || (strategy === "balanced" ? 88 : 56);

    for (let t = 0; t < count; t++) {
      let best = null;
      let bestObjective = -Infinity;
      let fallback = null;
      let bestPass = false;
      for (let attempt = 0; attempt < baseAttempts; attempt++) {
        const main = sampleZone(stats.main, pick, strategy, rng, mainExcluded);
        const special = cfg.special
          ? sampleZone(stats.special, cfg.special.pick, strategy, rng, specialExcluded)
          : [];
        const key = main.join("-") + "|" + special.join("-");
        if (usedMain.has(key)) continue;
        const scored = scoreSet(main, stats, cfg, pick);
        const candidate = {
          main,
          special,
          score: scored.score,
          subscores: scored.subscores,
          metrics: scored.metrics,
          stats,
        };
        if (!fallback || candidate.score > fallback.score) fallback = candidate;
        const passed = passesFilters(candidate.metrics, filters, pick, cfg.main.max);
        if (!passed) continue;
        const objective = objectiveOf(candidate, strategy);
        if (!bestPass || objective > bestObjective) {
          best = candidate;
          bestObjective = objective;
          bestPass = true;
        }
        if (strategy === "random") break;
        if (strategy === "balanced" && best && best.score >= 97.5) break;
      }
      if (!best) {
        best = fallback;
        relaxed++;
      }
      if (!best) {
        // 极端杀号情况下退回均匀抽样
        const main = sampleZone(stats.main, pick, "random", rng, mainExcluded);
        const special = cfg.special
          ? sampleZone(stats.special, cfg.special.pick, "random", rng, specialExcluded)
          : [];
        const scored = scoreSet(main, stats, cfg, pick);
        best = {
          main,
          special,
          score: scored.score,
          subscores: scored.subscores,
          metrics: scored.metrics,
          stats,
        };
        relaxed++;
      }
      const key = best.main.join("-") + "|" + best.special.join("-");
      if (usedMain.has(key) && count > 1) {
        // 去重：极少数情况下重新抽样一注
        const main = sampleZone(stats.main, pick, strategy, rng, mainExcluded);
        const special = cfg.special
          ? sampleZone(stats.special, cfg.special.pick, strategy, rng, specialExcluded)
          : [];
        const scored = scoreSet(main, stats, cfg, pick);
        best = {
          main,
          special,
          score: scored.score,
          subscores: scored.subscores,
          metrics: scored.metrics,
          stats,
        };
      }
      usedMain.add(best.main.join("-") + "|" + best.special.join("-"));
      const { stats: statsRef, ...ticket } = best;
      ticket.mainLabel = cfg.mainLabel;
      ticket.specialLabel = cfg.specialLabel;
      ticket.pick = pick;
      tickets.push(ticket);
    }

    return {
      tickets,
      stats,
      meta: {
        game,
        strategy,
        strategyName: STRATEGIES[strategy].name,
        count,
        pick,
        windowSize: stats.windowSize,
        seed: Number(seed),
        generatedAt: new Date().toISOString(),
        relaxed,
      },
    };
  }

  /**
   * 回测：在历史每期开奖前，仅使用此前数据生成 1 注，
   * 统计它与真实开奖的命中个数。用于诚实地展示“统计选号≠提高概率”。
   */
  function backtest(options) {
    const {
      game,
      draws,
      strategy = "balanced",
      windowSize = 100,
      filters = { odd: true, size: true, sum: true, consecutive: true, coverage: true },
      pick: requestedPick,
      sample = 60,
      seed = 20261106,
    } = options;
    const cfg = GAMES[game];
    if (!cfg) throw new Error("未知彩种：" + game);
    if (!Array.isArray(draws) || draws.length < 80) throw new Error("历史数据不足以回测");
    const pick = getPickCount(game, requestedPick);
    const count = Math.min(sample, draws.length - 60);
    const start = draws.length - count;
    const rows = [];
    for (let i = start; i < draws.length; i++) {
      const history = draws.slice(0, i);
      const actual = draws[i];
      const result = generate({
        game,
        draws: history,
        strategy,
        count: 1,
        windowSize,
        filters,
        pick,
        seed: seed + i * 97,
        attempts: 36,
      });
      const ticket = result.tickets[0];
      const mainHits = intersectionCount(ticket.main, actual.main);
      const specialHits = cfg.special ? intersectionCount(ticket.special, actual.special || []) : null;
      rows.push({
        issue: actual.issue,
        date: actual.date,
        ticketMain: ticket.main,
        ticketSpecial: ticket.special,
        actualMain: actual.main,
        actualSpecial: actual.special || [],
        mainHits,
        specialHits,
        score: ticket.score,
      });
    }
    const observedMain = cfg.main.observed;
    const expectedMain = (pick * observedMain) / cfg.main.max;
    const expectedSpecial = cfg.special ? (cfg.special.pick * cfg.special.observed) / cfg.special.max : 0;
    return {
      game,
      sample: rows.length,
      rows,
      avgMain: round(average(rows.map((r) => r.mainHits)), 2),
      expectedMain: round(expectedMain, 2),
      avgSpecial: cfg.special ? round(average(rows.map((r) => r.specialHits || 0)), 2) : null,
      expectedSpecial: cfg.special ? round(expectedSpecial, 2) : null,
      best: rows.reduce((a, b) => (b.mainHits > a.mainHits ? b : a), rows[0]),
    };
  }

  function describeTicket(ticket, cfg) {
    const parts = [ticket.main.map((n) => String(n).padStart(2, "0")).join(" ")];
    if (ticket.special?.length) {
      parts.push("+ " + ticket.special.map((n) => String(n).padStart(2, "0")).join(" "));
    }
    return parts.join(" ");
  }

  return {
    GAMES,
    STRATEGIES,
    getPickOptions,
    getPickCount,
    prepare,
    generate,
    backtest,
    scoreSet,
    metricsOf,
    analyticSum,
    makeRng,
    makeSeed,
    describeTicket,
    clamp,
  };
});
