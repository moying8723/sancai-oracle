/**
 * 天机三彩 — 历史开奖数据抓取与校验
 *
 * 数据源（GitHub Actions 海外机器已实测可访问）：
 *  - 500彩票网 · 开奖 XML：完整历史号码 / 期号 / 日期
 *  - 500彩票网 · 最新开奖页：奖池、销量、头奖注数与单注奖金（GBK）
 *
 * 运行：node tools/fetch_data.mjs
 * 产出：data.json、js/data.js
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const REFERER = "https://kaijiang.500.com/";

const GAMES = {
  dlt: {
    limit: 428,
    xml: "https://kaijiang.500.com/static/info/kaijiang/xml/dlt/list.xml",
    page: "https://kaijiang.500.com/shtml/dlt/",
    rules: { mainCount: 5, mainMax: 35, specialCount: 2, specialMax: 12 },
    convertIssue: (issue) => issue,
  },
  ssq: {
    limit: 300,
    xml: "https://kaijiang.500.com/static/info/kaijiang/xml/ssq/list.xml",
    page: "https://kaijiang.500.com/shtml/ssq/",
    rules: { mainCount: 6, mainMax: 33, specialCount: 1, specialMax: 16 },
    // 500 XML 的期号是 26127，官方 7 位期号是 2026127
    convertIssue: (issue) => `20${issue}`,
  },
  kl8: {
    limit: 400,
    xml: "https://kaijiang.500.com/static/info/kaijiang/xml/kl8/list.xml",
    page: "https://kaijiang.500.com/shtml/kl8/",
    rules: { mainCount: 20, mainMax: 80, specialCount: 0, specialMax: 0 },
    convertIssue: (issue) => issue,
  },
};

async function fetchBuffer(url, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Referer: REFERER,
          Accept: "text/xml,text/html,application/json,*/*",
        },
        signal: AbortSignal.timeout(35000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
    }
  }
  throw new Error(`请求失败：${url}（${lastError?.message}）`);
}

async function fetchXml(url) {
  const buffer = await fetchBuffer(url);
  return buffer.toString("utf8");
}

async function fetchPage(url) {
  const buffer = await fetchBuffer(url);
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function parseAttrs(source) {
  const attrs = {};
  for (const match of source.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function parseMoney(value, unit) {
  const number = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(number)) return null;
  if (unit === "亿") return Math.round(number * 1e8);
  if (unit === "万") return Math.round(number * 1e4);
  return Math.round(number);
}

function validateDraws(key, draws, rules) {
  if (!Array.isArray(draws) || draws.length < 100) {
    throw new Error(`${key}: 开奖数据不足（${draws?.length || 0}）`);
  }
  const issues = new Set();
  let previousIssue = -Infinity;
  for (const [index, draw] of draws.entries()) {
    if (!draw.issue || issues.has(draw.issue)) {
      throw new Error(`${key}: 期号重复/缺失 ${draw.issue}`);
    }
    issues.add(draw.issue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draw.date) || Number.isNaN(Date.parse(draw.date))) {
      throw new Error(`${key}: 日期异常 ${draw.issue} ${draw.date}`);
    }
    const numericIssue = Number(String(draw.issue).slice(-5));
    if (numericIssue <= previousIssue) throw new Error(`${key}: 期号未按升序 ${draw.issue}`);
    previousIssue = numericIssue;
    if (draw.main.length !== rules.mainCount) {
      throw new Error(`${key}: ${draw.issue} 主区数量 ${draw.main.length}`);
    }
    if (rules.specialCount > 0) {
      if (!Array.isArray(draw.special) || draw.special.length !== rules.specialCount) {
        throw new Error(`${key}: ${draw.issue} 特别区数量异常`);
      }
    }
    for (const number of [...draw.main, ...(draw.special || [])]) {
      if (!Number.isInteger(number)) throw new Error(`${key}: ${draw.issue} 号码非整数`);
    }
    if (draw.main.some((n) => n < 1 || n > rules.mainMax)) {
      throw new Error(`${key}: ${draw.issue} 主区越界`);
    }
    if (new Set(draw.main).size !== draw.main.length) throw new Error(`${key}: ${draw.issue} 主区重复`);
    for (let i = 1; i < draw.main.length; i++) {
      if (draw.main[i] <= draw.main[i - 1]) throw new Error(`${key}: ${draw.issue} 主区未排序`);
    }
    if (rules.specialCount > 0) {
      if (draw.special.some((n) => n < 1 || n > rules.specialMax)) {
        throw new Error(`${key}: ${draw.issue} 特别区越界`);
      }
      if (new Set(draw.special).size !== draw.special.length) {
        throw new Error(`${key}: ${draw.issue} 特别区重复`);
      }
      for (let i = 1; i < draw.special.length; i++) {
        if (draw.special[i] <= draw.special[i - 1]) {
          throw new Error(`${key}: ${draw.issue} 特别区未排序`);
        }
      }
    }
    if (index && draw.date < draws[index - 1].date) throw new Error(`${key}: 日期未按升序`);
  }
}

function parseXmlDraws(key, xml) {
  const config = GAMES[key];
  const rows = [...xml.matchAll(/<row\b([^>]*)\/?>/g)]
    .map((match) => parseAttrs(match[1]))
    .filter((row) => row.expect && row.opencode && row.opentime);
  const draws = [];
  for (const row of rows) {
    const issues = config.convertIssue(row.expect);
    const [mainPart, specialPart = ""] = row.opencode.split("|");
    const main = mainPart
      .split(",")
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    const special = specialPart
      .split(",")
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    const date = row.opentime.slice(0, 10);
    if (!/^\d{5,7}$/.test(issues)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    draws.push({
      issue: issues,
      date,
      main,
      special,
      pool: null,
      sales: null,
      firstPrizeCount: null,
      firstPrize: null,
    });
  }
  draws.sort((a, b) => a.date.localeCompare(b.date) || a.issue.localeCompare(b.issue));
  // XML 是倒序的，保留最近 N 期
  const trimmed = draws.slice(-config.limit);
  validateDraws(key, trimmed, config.rules);
  return trimmed;
}

function parseLatestPageStats(key, html) {
  const stats = { pool: null, sales: null, firstPrizeCount: null, firstPrize: null };
  const text = html;
  const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

  if (key === "ssq") {
    const sales = text.match(/本期销量：\s*<span\s+class="cfont1\s*">([\d,]+)元/);
    const pool = text.match(/奖池滚存：\s*<span\s+class="cfont1\s*">([\d,]+)元/);
    stats.sales = sales ? parseNumber(sales[1]) : null;
    stats.pool = pool ? parseNumber(pool[1]) : null;
    const prize = plain.match(/一等奖\s+([\d,]+)\s+([\d,]+)/);
    if (prize) {
      stats.firstPrizeCount = parseNumber(prize[1]);
      stats.firstPrize = parseNumber(prize[2]);
    }
  } else if (key === "dlt") {
    const sales = text.match(/本期全国销售金额：\s*<span\s+class="cfont1">([\d.,]+)(亿|万)?<\/span>/);
    const pool = text.match(/奖池滚存：\s*<span\s+class="cfont1">([\d.,]+)(亿|万)?<\/span>/);
    stats.sales = sales ? parseMoney(sales[1], sales[2]) : null;
    stats.pool = pool ? parseMoney(pool[1], pool[2]) : null;
    const prize = plain.match(/一等奖\s+基本\s+([\d,]+)\s+([\d,]+)/);
    if (prize) {
      stats.firstPrizeCount = parseNumber(prize[1]);
      stats.firstPrize = parseNumber(prize[2]);
    }
  } else if (key === "kl8") {
    const sales = text.match(/本期销量：\s*<span\s+class="cfont1\s*">([\d,]+)元/);
    const pool = text.match(/“选十”玩法奖池金额：\s*<span\s+class="cfont1\s*">([\d,]+)元/);
    stats.sales = sales ? parseNumber(sales[1]) : null;
    stats.pool = pool ? parseNumber(pool[1]) : null;
    const prize = plain.match(/选十\s+中10\s+([\d,]+)\s+([\d,]+)/);
    if (prize) {
      stats.firstPrizeCount = parseNumber(prize[1]);
      stats.firstPrize = parseNumber(prize[2]);
    }
  }
  return stats;
}

const [xmlDlt, xmlSsq, xmlKl8, pageDlt, pageSsq, pageKl8] = await Promise.all([
  fetchXml(GAMES.dlt.xml),
  fetchXml(GAMES.ssq.xml),
  fetchXml(GAMES.kl8.xml),
  fetchPage(GAMES.dlt.page).catch((error) => {
    console.warn("大乐透开奖页读取失败，奖池/销量留空：", error.message);
    return "";
  }),
  fetchPage(GAMES.ssq.page).catch((error) => {
    console.warn("双色球开奖页读取失败，奖池/销量留空：", error.message);
    return "";
  }),
  fetchPage(GAMES.kl8.page).catch((error) => {
    console.warn("快乐8开奖页读取失败，奖池/销量留空：", error.message);
    return "";
  }),
]);

const dlt = parseXmlDraws("dlt", xmlDlt);
const ssq = parseXmlDraws("ssq", xmlSsq);
const kl8 = parseXmlDraws("kl8", xmlKl8);

const pageStats = {
  dlt: parseLatestPageStats("dlt", pageDlt),
  ssq: parseLatestPageStats("ssq", pageSsq),
  kl8: parseLatestPageStats("kl8", pageKl8),
};
for (const [key, draws] of Object.entries({ dlt, ssq, kl8 })) {
  const latest = draws[draws.length - 1];
  Object.assign(latest, pageStats[key]);
}

const lastDate = (draws) => draws[draws.length - 1].date;
const asOf = [lastDate(dlt), lastDate(ssq), lastDate(kl8)].sort().at(-1);
const data = {
  meta: {
    title: "天机三彩 · 内置历史开奖数据",
    generatedAt: new Date().toISOString(),
    asOf,
    note: "历史开奖来自 500彩票网公开 XML，奖池/销量/头奖信息来自其开奖页；开奖结果随机，历史数据不代表未来走势。",
    sources: {
      dlt: {
        name: "500彩票网 · 大乐透开奖 XML / 开奖页",
        url: GAMES.dlt.xml,
      },
      ssq: {
        name: "500彩票网 · 双色球开奖 XML / 开奖页",
        url: GAMES.ssq.xml,
      },
      kl8: {
        name: "500彩票网 · 快乐8开奖 XML / 开奖页",
        url: GAMES.kl8.xml,
      },
    },
    games: {
      dlt: { drawCount: dlt.length, first: dlt[0], last: dlt.at(-1) },
      ssq: { drawCount: ssq.length, first: ssq[0], last: ssq.at(-1) },
      kl8: { drawCount: kl8.length, first: kl8[0], last: kl8.at(-1) },
    },
  },
  games: {
    dlt: { issue: dlt.at(-1).issue, draws: dlt },
    ssq: { issue: ssq.at(-1).issue, draws: ssq },
    kl8: { issue: kl8.at(-1).issue, draws: kl8 },
  },
};

await fs.mkdir(path.join(ROOT, "js"), { recursive: true });
await fs.writeFile(path.join(ROOT, "data.json"), JSON.stringify(data), "utf8");
const js = `/* 天机三彩 · 历史开奖数据（自动生成，请勿手改）\n * 数据来源：500彩票网公开开奖 XML / 开奖页，截止 ${asOf}\n * 彩票开奖结果为独立随机事件，历史数据仅供统计展示与娱乐。\n */\nwindow.LOTTERY_DATA = ${JSON.stringify(data)};\n`;
await fs.writeFile(path.join(ROOT, "js", "data.js"), js, "utf8");

const summary = Object.entries(data.games)
  .map(([key, game]) => {
    const latest = game.draws.at(-1);
    const stats = pageStats[key];
    return `${key}: ${game.draws.length} 期 | ${game.draws[0].date} → ${latest.date} | 最新 ${latest.issue} | 号码 ${latest.main.join(" ")}${latest.special.length ? " + " + latest.special.join(" ") : ""} | 奖池 ${stats.pool ?? "—"} | 销量 ${stats.sales ?? "—"} | 头奖 ${stats.firstPrizeCount ?? "—"} 注`;
  })
  .join("\n");
console.log(`数据写入完成（asOf ${asOf}）\n${summary}\n数据文件：data.json / js/data.js`);
