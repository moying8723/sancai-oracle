/**
 * 天机三彩 — 历史开奖数据抓取与校验
 * 数据来源：
 *  - 双色球 / 快乐8：中国福利彩票发行管理中心官网公开接口
 *  - 超级大乐透：500彩票网历史开奖页
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

async function fetchText(url, referer, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Referer: referer,
          Accept: "text/html,application/json,*/*",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`请求失败: ${url} (${lastError?.message})`);
}

const toNumber = (value) => {
  if (value === undefined || value === null) return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const stripTags = (value) => value.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
const isYmd = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

function validateDraws(key, draws, rules) {
  if (!Array.isArray(draws) || draws.length < 100) {
    throw new Error(`${key}: 开奖数据不足 (${draws?.length || 0})`);
  }
  const issues = new Set();
  let prevIssue = -Infinity;
  for (const [index, draw] of draws.entries()) {
    if (!draw.issue || issues.has(draw.issue)) throw new Error(`${key}: 期号重复/缺失 ${draw.issue}`);
    issues.add(draw.issue);
    if (!isYmd(draw.date) || Number.isNaN(Date.parse(draw.date))) {
      throw new Error(`${key}: 日期异常 ${draw.issue} ${draw.date}`);
    }
    const numericIssue = Number(String(draw.issue).slice(-5));
    if (numericIssue <= prevIssue) throw new Error(`${key}: 期号未按升序 ${draw.issue}`);
    prevIssue = numericIssue;
    if (draw.main.length !== rules.mainCount) {
      throw new Error(`${key}: ${draw.issue} 主区数量 ${draw.main.length}`);
    }
    if (rules.specialCount > 0) {
      if (!Array.isArray(draw.special) || draw.special.length !== rules.specialCount) {
        throw new Error(`${key}: ${draw.issue} 特别区数量异常`);
      }
    }
    for (const n of [...draw.main, ...(draw.special || [])]) {
      if (!Number.isInteger(n)) throw new Error(`${key}: ${draw.issue} 号码非整数`);
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

/* ------------------------------ 超级大乐透 ------------------------------ */
async function fetchDlt() {
  const url =
    "https://datachart.500.com/dlt/history/newinc/history.php?start=24001&end=26150";
  const html = await fetchText(url, "https://datachart.500.com/dlt/");
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const draws = [];
  const cellsRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
  for (const row of rows) {
    const cells = [...row.matchAll(cellsRegex)].map((m) => stripTags(m[1]));
    const index = cells.findIndex((c) => /^\d{5}$/.test(c));
    if (index < 0) continue;
    const nums = cells.slice(index + 1, index + 8).map(Number);
    if (nums.length !== 7 || nums.some((n) => !Number.isInteger(n))) continue;
    const main = nums.slice(0, 5);
    const special = nums.slice(5, 7);
    if (main.some((n) => n < 1 || n > 35) || special.some((n) => n < 1 || n > 12)) continue;
    const date = cells.find(isYmd);
    if (!date) continue;
    draws.push({
      issue: cells[index],
      date,
      main,
      special,
      pool: toNumber(cells[index + 8]),
      sales: toNumber(cells[index + 13]),
      firstPrizeCount: toNumber(cells[index + 9]),
      firstPrize: toNumber(cells[index + 10]),
    });
  }
  draws.sort((a, b) => a.date.localeCompare(b.date) || a.issue.localeCompare(b.issue));
  validateDraws("dlt", draws, { mainCount: 5, mainMax: 35, specialCount: 2, specialMax: 12 });
  return draws;
}

/* ------------------------------ 双色球 / 快乐8 ------------------------------ */
async function fetchCwl(name, issueCount) {
  const url = `https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=${name}&issueCount=${issueCount}&pageNo=1&pageSize=${issueCount}&systemType=PC`;
  const text = await fetchText(url, "https://www.cwl.gov.cn/ygkj/wqkjgg/");
  const json = JSON.parse(text);
  if (json.state !== 0 || !Array.isArray(json.result)) {
    throw new Error(`${name}: 接口返回异常 ${text.slice(0, 160)}`);
  }
  const draws = json.result.map((item) => {
    const main = String(item.red || "")
      .split(",")
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    const special = String(item.blue || "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    const grades = Array.isArray(item.prizegrades) ? item.prizegrades : [];
    const topGrade =
      name === "ssq"
        ? grades.find((g) => Number(g.type) === 1)
        : grades.find((g) => g.type === "x10z10");
    return {
      issue: String(item.code),
      date: String(item.date || "").slice(0, 10),
      main,
      special: special.length ? special : [],
      pool: toNumber(item.poolmoney),
      sales: toNumber(item.sales),
      firstPrizeCount: toNumber(topGrade?.typenum),
      firstPrize: toNumber(topGrade?.typemoney),
    };
  });
  draws.sort((a, b) => a.date.localeCompare(b.date) || a.issue.localeCompare(b.issue));
  const rules =
    name === "ssq"
      ? { mainCount: 6, mainMax: 33, specialCount: 1, specialMax: 16 }
      : { mainCount: 20, mainMax: 80, specialCount: 0, specialMax: 0 };
  validateDraws(name, draws, rules);
  // 双色球/快乐8 保留最近 300 / 400 期，福利彩票接口足够稳定可整批使用
  return draws;
}

const [dlt, ssq, kl8] = await Promise.all([fetchDlt(), fetchCwl("ssq", 300), fetchCwl("kl8", 400)]);

const lastDate = (draws) => draws[draws.length - 1].date;
const asOf = [lastDate(dlt), lastDate(ssq), lastDate(kl8)].sort().at(-1);
const data = {
  meta: {
    title: "天机三彩 · 内置历史开奖数据",
    generatedAt: new Date().toISOString(),
    asOf,
    note: "仅内置历史开奖，开奖结果随机，历史数据不代表未来走势。",
    sources: {
      dlt: {
        name: "500彩票网 · 超级大乐透历史开奖",
        url: "https://datachart.500.com/dlt/history/",
      },
      ssq: {
        name: "中国福利彩票发行管理中心 · 双色球",
        url: "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/",
      },
      kl8: {
        name: "中国福利彩票发行管理中心 · 快乐8",
        url: "https://www.cwl.gov.cn/ygkj/wqkjgg/kl8/",
      },
    },
    games: {
      dlt: { drawCount: dlt.length, first: dlt[0], last: dlt.at(-1) },
      ssq: { drawCount: ssq.length, first: ssq[0], last: ssq.at(-1) },
      kl8: { drawCount: kl8.length, first: kl8[0], last: kl8.at(-1) },
    },
  },
  games: {
    dlt: {
      issue: dlt.at(-1).issue,
      draws: dlt,
    },
    ssq: {
      issue: ssq.at(-1).issue,
      draws: ssq,
    },
    kl8: {
      issue: kl8.at(-1).issue,
      draws: kl8,
    },
  },
};

await fs.mkdir(path.join(ROOT, "js"), { recursive: true });
await fs.writeFile(path.join(ROOT, "data.json"), JSON.stringify(data), "utf8");
const js = `/* 天机三彩 · 历史开奖数据（自动生成，请勿手改）\n * 数据来源：中国福利彩票官网 / 500彩票网，截止 ${asOf}\n * 彩票开奖结果为独立随机事件，历史数据仅供统计展示与娱乐。\n */\nwindow.LOTTERY_DATA = ${JSON.stringify(data)};\n`;
await fs.writeFile(path.join(ROOT, "js", "data.js"), js, "utf8");

const summary = Object.entries(data.games)
  .map(([key, game]) => {
    const latest = game.draws.at(-1);
    return `${key}: ${game.draws.length} 期 | ${game.draws[0].date} → ${latest.date} | 最新 ${latest.issue} | 号码 ${latest.main.join(" ")}${latest.special.length ? " + " + latest.special.join(" ") : ""}`;
  })
  .join("\n");
console.log(`数据写入完成 (asOf ${asOf})\n${summary}\n数据文件: data.json / js/data.js`);
