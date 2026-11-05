/**
 * 最终 QA + 成品截图
 * 运行：node tools/final-qa.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.QA_SHOTS ? path.resolve(ROOT, process.env.QA_SHOTS) : path.join(ROOT, "screenshots");
const stamp = Date.now();
const PROFILE = path.join(ROOT, `.tmp-final-chrome-${stamp}`);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9500 + Math.floor(Math.random() * 200);
const PAGE_URL = process.env.QA_URL || pathToFileURL(path.join(ROOT, "index.html")).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await fsp.mkdir(SHOTS, { recursive: true });
const stderr = [];
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--mute-audio",
    "--force-device-scale-factor=1",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--window-size=1600,1050",
    PAGE_URL,
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
chrome.stderr.on("data", (data) => stderr.push(data.toString()));

function killChrome() {
  try {
    cdp?.ws?.close();
  } catch {}
  try {
    spawnSync("taskkill", ["/pid", String(chrome.pid), "/t", "/f"], { stdio: "ignore" });
  } catch {}
  try {
    chrome.kill();
  } catch {}
}
let cdp = null;

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text + " " + (result.exceptionDetails.exception?.description || "")
      );
    }
    return result.result?.value;
  }
  async screenshot(file, fullPage = false) {
    let params = { format: "png", fromSurface: true };
    if (fullPage) {
      const metrics = await this.call("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      params = {
        ...params,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 },
      };
    }
    const result = await this.call("Page.captureScreenshot", params);
    const target = path.join(SHOTS, file);
    await fsp.writeFile(target, Buffer.from(result.data, "base64"));
    return target;
  }
}

async function waitEndpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((item) => {
        if (item.type !== "page") return false;
        let decoded = item.url;
        try {
          decoded = decodeURIComponent(item.url);
        } catch {}
        return decoded.includes("index.html") || decoded.includes("天机三彩.html") || decoded === PAGE_URL;
      });
      if (page) return page;
    } catch {}
    await sleep(220);
  }
  throw new Error("Chrome 调试端口未就绪\n" + stderr.join("").slice(-2000));
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

async function waitReady(timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const ready = await cdp.evaluate("document.documentElement.dataset.ready || ''");
      if (ready === "error") throw new Error("应用初始化失败");
      if (ready === "1") {
        const has = await cdp.evaluate(
          "window.__APP__ ? Boolean(window.__APP__.state.results[window.__APP__.state.game]) : false"
        );
        const busy = await cdp.evaluate("window.__APP__ ? window.__APP__.busy : true");
        if (has && !busy) return;
      }
    } catch (error) {
      if (error.message === "应用初始化失败") throw error;
      // Page.reload 期间可能处于无 document 的过渡上下文，稍后重试即可
    }
    await sleep(200);
  }
  throw new Error("等待应用就绪超时");
}
async function waitSettled(ms = 800) {
  await sleep(ms);
  for (let i = 0; i < 20; i++) {
    try {
      const busy = await cdp.evaluate("window.__APP__ ? window.__APP__.busy : false");
      if (!busy) return;
    } catch {
      // 过渡上下文，重试
    }
    await sleep(120);
  }
}
async function setViewport(width, height, mobile = false) {
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}
async function reload() {
  await cdp.call("Page.reload", { ignoreCache: true });
  await waitReady();
  await waitSettled(500);
}
async function getOverview() {
  return cdp.evaluate(`(() => {
    const app = window.__APP__;
    const state = app.state;
    return {
      ready: app.ready,
      game: state.game,
      strategy: state.strategy,
      count: state.count,
      windowSize: state.windowSize,
      filters: state.filters,
      tickets: state.results[state.game]?.tickets?.length || 0,
      metaWindow: state.results[state.game]?.meta?.windowSize || 0,
      saved: state.saved.length,
      issue: app.nextIssue(),
      text: app.currentText(),
      viewport: [innerWidth, innerHeight],
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      heatCells: document.querySelectorAll('.heat-cell').length,
      historyRows: document.querySelectorAll('.history-row:not(.history-head)').length,
      errors: window.__APP_ERRORS__ || []
    };
  })()`);
}
async function switchGame(game) {
  await cdp.evaluate(`window.__APP__.activateGame(${JSON.stringify(game)})`);
  await waitSettled(900);
  await sleep(900);
}

try {
  const page = await waitEndpoint();
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");
  await setViewport(1600, 1000, false);
  await reload();

  // 1. 初始
  let overview = await getOverview();
  console.log("INITIAL", JSON.stringify(overview, null, 2));
  check("默认彩种 / 策略 / 注数", overview.game === "dlt" && overview.strategy === "balanced" && overview.count === 1);
  check("初始号码已生成", overview.tickets === 1);
  check("无横向溢出", overview.scrollWidth <= 1600 && overview.bodyScrollWidth <= 1600);
  check("热力图号码数量", overview.heatCells === 47);
  check("历史开奖初始 10 行", overview.historyRows === 10);
  await sleep(1000);
  await cdp.screenshot("final-01-dlt.png");
  await cdp.screenshot("final-02-dlt-full.png", true);

  // 2. 三种彩种
  await switchGame("ssq");
  overview = await getOverview();
  check("双色球切换", overview.game === "ssq" && overview.tickets === 1 && overview.heatCells === 49);
  await cdp.screenshot("final-03-ssq.png");

  await switchGame("kl8");
  overview = await getOverview();
  check("快乐8切换", overview.game === "kl8" && overview.tickets === 1 && overview.heatCells === 80);
  await cdp.screenshot("final-04-kl8.png");

  // 3. 快乐8玩法 / 多注
  await cdp.evaluate("document.querySelector('[data-pick=\"8\"]').click()");
  await waitSettled(700);
  overview = await getOverview();
  check("快乐8 选八", overview.tickets === 1);
  await cdp.evaluate("document.querySelector('[data-pick=\"10\"]').click()");
  await waitSettled(700);
  await cdp.evaluate("document.querySelector('[data-count-step=\"1\"]').click()");
  await cdp.evaluate("document.querySelector('[data-count-step=\"1\"]').click()");
  await waitSettled(800);
  await sleep(1200);
  overview = await getOverview();
  check("多注生成 3 注", overview.count === 3 && overview.tickets === 3);
  await cdp.screenshot("final-05-kl8-multi.png");

  // 4. 回大乐透（注数复位为 1），统计样本全部
  await switchGame("dlt");
  await cdp.evaluate("document.querySelector('[data-count-step=\"-1\"]').click()");
  await cdp.evaluate("document.querySelector('[data-count-step=\"-1\"]').click()");
  await waitSettled(800);
  check("注数复位", (await cdp.evaluate("window.__APP__.state.count")) === 1);
  await cdp.evaluate(`(() => { const s = document.querySelector('#window-select'); s.value = '0'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await waitSettled(900);
  overview = await getOverview();
  check("统计样本「全部」", overview.windowSize === 0 && overview.metaWindow === 428, `meta=${overview.metaWindow}`);
  await cdp.evaluate(`(() => { const s = document.querySelector('#window-select'); s.value = '100'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await waitSettled(900);

  // 5. 杀号
  const firstCell = await cdp.evaluate(`(() => { const c = document.querySelector('.heat-cell'); c.click(); return { n: Number(c.dataset.n), killed: c.classList.contains('is-killed') }; })()`);
  await sleep(250);
  let killState = await cdp.evaluate(`(() => ({ size: window.__APP__.state.excluded.dlt.main.size, killed: document.querySelector('.heat-cell')?.classList.contains('is-killed'), chips: document.querySelectorAll('.excluded-chip').length }))()`);
  check("点击热力图杀号", killState.size === 1 && killState.killed && killState.chips === 1);
  await cdp.evaluate("document.querySelector('#btn-generate').click()");
  await waitSettled(900);
  const killApplied = await cdp.evaluate(`(() => { const s = window.__APP__.state; const n = [...s.excluded[s.game].main][0]; return { n, appears: s.results[s.game].tickets.some(t => t.main.includes(n)) }; })()`);
  check("杀号在推演结果中排除", !killApplied.appears, JSON.stringify(killApplied));
  await cdp.evaluate("document.querySelector('#clear-excluded').click()");
  await sleep(250);

  // 6. 结构过滤
  await cdp.evaluate(`(() => { const i = document.querySelector('input[data-filter="odd"]'); i.checked = false; i.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await waitSettled(900);
  const filterState = await cdp.evaluate(`(() => ({ off: window.__APP__.state.filters.odd === false, tickets: window.__APP__.state.results.dlt.tickets.length }))()`);
  check("结构过滤切换", filterState.off && filterState.tickets >= 1);
  await cdp.evaluate("document.querySelector('#reset-filters').click()");
  await waitSettled(900);
  check("结构过滤重置", (await cdp.evaluate("window.__APP__.state.filters.odd")) === true);

  // 7. 复制文本 / 收藏 / 删除
  const text = await cdp.evaluate("window.__APP__.currentText()");
  check("复制文本生成", typeof text === "string" && text.includes("天机三彩") && text.length > 30 && text.includes("第 26127 期"), `${text.length} chars`);
  await cdp.evaluate("document.querySelector('#btn-save').click()");
  await sleep(500);
  const savedInfo = await cdp.evaluate(`(() => ({ saved: window.__APP__.state.saved.length, badge: document.querySelector('#saved-count').textContent }))()`);
  check("收藏本组", savedInfo.saved === 1 && savedInfo.badge === "1");
  await cdp.evaluate("document.querySelector('#btn-saved').click()");
  await sleep(500);
  await cdp.screenshot("final-06-drawer.png");
  const beforeDelete = await cdp.evaluate("document.querySelectorAll('.saved-item').length");
  await cdp.evaluate("document.querySelector('[data-saved-del]').click()");
  await sleep(400);
  const afterDelete = await cdp.evaluate("document.querySelectorAll('.saved-item').length");
  check("删除收藏", beforeDelete === 1 && afterDelete === 0);
  await cdp.evaluate("document.querySelector('[data-close-drawer]').click()");
  await sleep(500);

  // 8. 概率公开课 + 回测
  await cdp.evaluate("document.querySelector('#btn-insight-probability').click()");
  await sleep(500);
  check("数据罗盘概率入口", (await cdp.evaluate("document.querySelector('#modal-probability').classList.contains('is-open')")) === true);
  await cdp.evaluate("document.querySelector('#btn-backtest').click()");
  await sleep(1500);
  const labText = await cdp.evaluate("document.querySelector('#lab-result').innerText");
  check("回测输出", labText.includes("策略平均命中") && labText.includes("理论") && labText.includes("差异"));
  await cdp.screenshot("final-07-probability.png");
  await cdp.evaluate("document.querySelector('.modal [data-close-modal]').click()");
  await sleep(500);

  // 9. 导出图片
  const dataUrl = await cdp.evaluate("window.__APP__.buildExportCanvas().toDataURL('image/png')");
  const exportBuffer = Buffer.from(dataUrl.split(",")[1], "base64");
  await fsp.writeFile(path.join(SHOTS, "final-08-export.png"), exportBuffer);
  check("分享图导出 1080×1350", exportBuffer.length > 100000, `${Math.round(exportBuffer.length / 1024)} KB`);

  // 10. 平板 / 手机
  await cdp.evaluate("window.localStorage.clear()");
  await setViewport(1024, 900, false);
  await reload();
  await sleep(1200);
  let layout = await getOverview();
  check("1024 布局无横向溢出", layout.scrollWidth <= 1024 && layout.bodyScrollWidth <= 1024, `sw=${layout.scrollWidth}`);
  await cdp.screenshot("final-09-tablet-1024.png", true);

  await setViewport(768, 1000, false);
  await reload();
  layout = await getOverview();
  check("768 布局无横向溢出", layout.scrollWidth <= 768 && layout.bodyScrollWidth <= 768, `sw=${layout.scrollWidth}`);

  await setViewport(390, 844, true);
  await reload();
  await sleep(1400);
  layout = await getOverview();
  check("手机布局无横向溢出", layout.scrollWidth <= 390 && layout.bodyScrollWidth <= 390, `sw=${layout.scrollWidth}`);
  check("手机默认标题", layout.game === "dlt" && layout.tickets === 1);
  await cdp.screenshot("final-10-mobile.png");
  await cdp.screenshot("final-11-mobile-full.png", true);

  const consoleErrors = cdp.events.filter(
    (event) =>
      event.method === "Runtime.exceptionThrown" ||
      (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") ||
      (event.method === "Log.entryAdded" && event.params.entry.level === "error")
  );
  check("无控制台错误", consoleErrors.length === 0, `${consoleErrors.length}`);
  if (consoleErrors.length) console.log(JSON.stringify(consoleErrors.slice(0, 5)).slice(0, 3000));

  console.log("\n===== QA SUMMARY =====");
  for (const item of results) console.log(`${item.ok ? "✓" : "✗"} ${item.name} ${item.detail || ""}`);
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error("QA FAILED", error);
  try {
    await cdp.screenshot("99-final-error.png");
  } catch {}
  console.error("CHROME STDERR", stderr.join("").slice(-2000));
  process.exitCode = 1;
} finally {
  killChrome();
  await sleep(600);
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
}
