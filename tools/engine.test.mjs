import fs from "node:fs";
import assert from "node:assert/strict";
import engine from "../js/engine.js";

const data = JSON.parse(fs.readFileSync(new URL("../data.json", import.meta.url), "utf8"));
const { GAMES, STRATEGIES, generate, prepare, backtest, getPickOptions } = engine;

let assertions = 0;
function check(label, condition, extra = "") {
  assertions++;
  if (!condition) throw new Error(`FAIL: ${label} ${extra}`);
}
const isSortedUnique = (arr) => arr.every((n, i) => i === 0 || n > arr[i - 1]);

console.log("数据摘要：");
for (const key of Object.keys(GAMES)) {
  const draws = data.games[key].draws;
  console.log(` ${key}: ${draws.length} 期, ${draws[0].date} → ${draws.at(-1).date}`);
  check(`${key} 数据条数`, draws.length >= 200);
  check(`${key} 日期升序`, draws.every((d, i) => i === 0 || d.date >= draws[i - 1].date));
  const stats = prepare(key, draws, 100);
  check(`${key} 统计窗口`, stats.windowSize === 100);
  check(`${key} 号码列表`, stats.main.list.length === GAMES[key].main.max);
  check(`${key} 热度范围`, stats.main.list.every((x) => x.heat >= 0 && x.heat <= 1));
  check(`${key} 遗漏非负`, stats.main.list.every((x) => x.omission >= 0));
  check(`${key} 排名`, stats.main.hotRanked.length === GAMES[key].main.max);
}

const start = performance.now();
for (const key of Object.keys(GAMES)) {
  const draws = data.games[key].draws;
  const cfg = GAMES[key];
  const pickOptions = getPickOptions(key);
  for (const strategy of Object.keys(STRATEGIES)) {
    for (const count of [1, 5]) {
      for (const pick of pickOptions.slice(0, key === "kl8" ? 3 : 1)) {
        const result = generate({
          game: key,
          draws,
          strategy,
          count,
          pick,
          windowSize: 100,
          seed: 123456,
          filters: { odd: true, size: true, sum: true, consecutive: true, coverage: true },
        });
        check(`${key}/${strategy} 注数`, result.tickets.length === count);
        check(`${key}/${strategy} 种子`, result.meta.seed === 123456);
        for (const ticket of result.tickets) {
          check(`${key}/${strategy} 主区数量`, ticket.main.length === pick, `${ticket.main.length}`);
          check(`${key}/${strategy} 主区排序`, isSortedUnique(ticket.main), ticket.main.join(","));
          check(
            `${key}/${strategy} 主区范围`,
            ticket.main.every((n) => n >= 1 && n <= cfg.main.max),
            ticket.main.join(","),
          );
          if (cfg.special) {
            check(`${key}/${strategy} 特区数量`, ticket.special.length === cfg.special.pick);
            check(`${key}/${strategy} 特区排序`, isSortedUnique(ticket.special));
            check(
              `${key}/${strategy} 特区范围`,
              ticket.special.every((n) => n >= 1 && n <= cfg.special.max),
            );
          } else {
            check(`${key} 无特区`, ticket.special.length === 0);
          }
          check(`${key}/${strategy} 结构分`, ticket.score >= 0 && ticket.score <= 100, String(ticket.score));
          check(`${key}/${strategy} 子分`, Object.keys(ticket.subscores).length === 6);
          check(`${key}/${strategy} 指标`, ticket.metrics.sum > 0 && ticket.metrics.ac >= 0);
        }
        const keySet = new Set(result.tickets.map((t) => t.main.join("-") + "|" + t.special.join("-")));
        check(`${key}/${strategy} 去重`, keySet.size === count);
      }
    }
  }
  console.log(` ${key} 生成性能：通过`);
}

// 可复现性
const a = generate({ game: "dlt", draws: data.games.dlt.draws, seed: 777, count: 3 });
const b = generate({ game: "dlt", draws: data.games.dlt.draws, seed: 777, count: 3 });
check("同种子复现", JSON.stringify(a.tickets) === JSON.stringify(b.tickets));

// 杀号
const kill = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const killed = generate({
  game: "dlt",
  draws: data.games.dlt.draws,
  seed: 99,
  count: 3,
  excluded: { main: kill, special: [1, 2] },
});
check("杀号不出现在结果", killed.tickets.every((t) => !t.main.some((n) => kill.includes(n)) && !t.special.some((n) => [1, 2].includes(n))));
let tooMany = false;
try {
  generate({ game: "dlt", draws: data.games.dlt.draws, seed: 1, excluded: { main: Array.from({ length: 33 }, (_, i) => i + 1) } });
} catch {
  tooMany = true;
}
check("过度杀号报错", tooMany);

// 快乐8选一至选十
for (let pick = 1; pick <= 10; pick++) {
  const r = generate({ game: "kl8", draws: data.games.kl8.draws, pick, count: 2, seed: pick, strategy: "balanced" });
  check(`快乐8 选${pick}`, r.tickets.every((t) => t.main.length === pick));
}

// 策略倾向：热号策略热度应高于冷号策略
const hot = generate({ game: "ssq", draws: data.games.ssq.draws, strategy: "hot", count: 5, seed: 2026 });
const cold = generate({ game: "ssq", draws: data.games.ssq.draws, strategy: "cold", count: 5, seed: 2026 });
const avgHeat = (result) => {
  const stats = result.stats;
  return result.tickets.reduce((acc, t) => acc + t.main.reduce((s, n) => s + stats.main.list[n - 1].heat, 0) / t.main.length, 0) / result.tickets.length;
};
check("热号策略热度 > 冷号策略", avgHeat(hot) > avgHeat(cold), `${avgHeat(hot)} vs ${avgHeat(cold)}`);

// 回测
for (const key of Object.keys(GAMES)) {
  const cfg = GAMES[key];
  const t0 = performance.now();
  const result = backtest({ game: key, draws: data.games[key].draws, sample: 20, pick: key === "kl8" ? 10 : undefined });
  const cost = Math.round(performance.now() - t0);
  check(`${key} 回测样本`, result.sample === 20);
  check(`${key} 回测命中范围`, result.rows.every((r) => r.mainHits >= 0 && r.mainHits <= Math.min(cfg.main.observed, 10)));
  check(`${key} 回测均值`, result.avgMain >= 0 && result.avgMain <= 10);
  if (cfg.special) {
    const exactSpecial = (cfg.special.pick * cfg.special.observed) / cfg.special.max;
    check(`${key} 特区期望`, Math.abs(result.expectedSpecial - exactSpecial) < 0.011, `${result.expectedSpecial} vs ${exactSpecial}`);
  }
  console.log(` ${key} 回测 20 期：${cost}ms，平均命中 ${result.avgMain} / 期望 ${result.expectedMain}`);
}

// 数据截止提示
console.log(`\n全部通过：${assertions} 项断言，耗时 ${Math.round(performance.now() - start)}ms`);
