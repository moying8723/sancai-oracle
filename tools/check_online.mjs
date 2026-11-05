/**
 * 在线版 PWA 检查（需要先运行 tools/serve_online.mjs）
 * 运行：node tools/check_online.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const URL = process.env.CHECK_URL || "http://127.0.0.1:8080/";
const PORT = 9800 + Math.floor(Math.random() * 80);
const PROFILE = path.resolve(`.tmp-check-chrome-${Date.now()}`);
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--remote-allow-origins=*", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1600,1000", URL,
], { stdio: ["ignore", "ignore", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((item) => item.type === "page" && decodeURIComponent(item.url).includes("127.0.0.1"));
    if (page) break;
  } catch {}
  await sleep(250);
}
if (!page) {
  console.error("未找到浏览器页面");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let cdpId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(msg.error) : resolve(msg.result);
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout " + method));
      }
    }, 15000);
  });
}
async function evaluate(expression, awaitPromise = false) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

await call("Runtime.enable");
for (let i = 0; i < 50; i++) {
  const ready = await evaluate("document.documentElement.dataset.ready || ''");
  if (ready === "1") break;
  await sleep(200);
}
await sleep(2200);
const info = await evaluate(
  `(async () => {
    const manifestLink = document.querySelector('link[rel="manifest"]')?.href || null;
    let manifest = null;
    try { manifest = await (await fetch('manifest.webmanifest', {cache:'no-store'})).json(); } catch (e) { manifest = {error:String(e)}; }
    let registration = null;
    try {
      const r = await navigator.serviceWorker.getRegistration();
      registration = r ? { scope: r.scope, active: r.active?.state || null, waiting: r.waiting?.state || null } : null;
    } catch (e) { registration = {error:String(e)}; }
    const cachesList = 'caches' in window ? await caches.keys() : [];
    return {
      title: document.title,
      ready: document.documentElement.dataset.ready,
      manifestLink,
      manifestName: manifest?.name,
      manifestStart: manifest?.start_url,
      manifestIcons: manifest?.icons?.length,
      theme: document.querySelector('meta[name="theme-color"]')?.content,
      appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      registration,
      caches: cachesList,
      viewport: [innerWidth, innerHeight]
    };
  })()`,
  true
);
console.log(JSON.stringify(info, null, 2));

const manifestRes = await fetch(new globalThis.URL("manifest.webmanifest", URL).href);
console.log("MANIFEST_HTTP", manifestRes.status, manifestRes.headers.get("content-type"));
const swRes = await fetch(new globalThis.URL("sw.js", URL).href);
console.log("SW_HTTP", swRes.status, swRes.headers.get("content-type"));

// 断网刷新，验证 Service Worker 离线缓存
await call("Page.enable");
await call("Network.enable");
await call("Network.emulateNetworkConditions", {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
});
await call("Page.reload", { ignoreCache: false });
await sleep(2600);
const offline = await evaluate(`({
  title: document.title,
  ready: document.documentElement.dataset.ready || null,
  tickets: window.__APP__?.state?.results?.[window.__APP__?.state?.game]?.tickets?.length || 0
})`);
console.log("OFFLINE_RELOAD", JSON.stringify(offline));
await call("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});

try { ws.close(); } catch {}
try { spawnSync("taskkill", ["/pid", String(chrome.pid), "/t", "/f"], { stdio: "ignore" }); } catch {}
try { chrome.kill(); } catch {}
