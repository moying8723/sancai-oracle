/**
 * 在线版本地预览 / 局域网访问
 * 运行：node tools/serve_online.mjs
 * 浏览器打开：http://localhost:8080/
 * 手机同一 Wi-Fi：http://<电脑局域网 IP>:8080/
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const PORT = Number(process.env.PORT || 8080);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let relative = decoded.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const full = path.resolve(ROOT, relative);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) return null;
  return full;
}

const server = http.createServer((request, response) => {
  const target = safeJoin(request.url || "/");
  if (!target) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".webmanifest" ? "no-cache" : "public, max-age=3600",
      "Service-Worker-Allowed": "/",
    };
    response.writeHead(200, headers);
    fs.createReadStream(target).pipe(response);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n天机三彩 · 在线版本地预览\n`);
  console.log(`本机：   http://localhost:${PORT}/`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) {
        console.log(`手机同一 Wi-Fi： http://${item.address}:${PORT}/`);
      }
    }
  }
  console.log(`\n说明：局域网访问需要电脑与手机在同一网络，系统防火墙可能需要放行 Node.js。`);
  console.log(`自动更新部署到公网请阅读 ONLINE.md。\n`);
});
