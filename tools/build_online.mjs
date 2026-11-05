/**
 * 在线版构建：单文件 App + PWA 元信息 / Service Worker 注册
 * 运行：node tools/build_online.mjs
 * 产出：site/index.html
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const app = await read("天机三彩.html");
const siteDir = path.join(ROOT, "site");
await fs.mkdir(siteDir, { recursive: true });

const headTags = `
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
  <meta name="application-name" content="天机三彩" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="天机三彩" />
`;

const swRegister = `
<script>
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))
  ) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    });
  }
</script>
`;

let html = app;
const themeTag = '<meta name="theme-color" content="#06080d" />';
if (!html.includes(themeTag)) throw new Error("未找到 theme-color 注入点");
html = html.replace(themeTag, themeTag + headTags);
if (!html.includes("</body>")) throw new Error("未找到 </body> 注入点");
html = html.replace("</body>", swRegister + "\n</body>");
html = html.replace(
  "<!DOCTYPE html>",
  "<!DOCTYPE html>\n<!-- 在线版：由 tools/build_online.mjs 生成；PWA / 自动更新部署见 ONLINE.md -->"
);

await fs.writeFile(path.join(siteDir, "index.html"), html, "utf8");
await fs.writeFile(path.join(siteDir, ".nojekyll"), "", "utf8");
await fs.writeFile(
  path.join(siteDir, "404.html"),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./"><title>天机三彩</title><body style="background:#05070b;color:#d8b86c;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">正在返回天机三彩…</body></html>',
  "utf8"
);

const required = [
  "site/manifest.webmanifest",
  "site/sw.js",
  "site/icons/icon-192.png",
  "site/icons/icon-512.png",
  "site/icons/apple-touch-icon.png",
];
for (const file of required) {
  try {
    await fs.access(path.join(ROOT, file));
  } catch {
    throw new Error(`缺少在线版资源：${file}`);
  }
}

const size = Buffer.byteLength(html, "utf8");
console.log(`在线版已生成：${path.join(siteDir, "index.html")}`);
console.log(`大小：${(size / 1024).toFixed(1)} KB · PWA 资源齐全`);
