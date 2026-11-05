/**
 * 将多文件版打包成可双击运行的单文件 HTML
 * 运行：node tools/build_single.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFile(path.join(ROOT, p), "utf8");
const escapeInline = (code) => code.replace(/<\/script/gi, "<\\/script");

const [html, css, data, engine, app] = await Promise.all([
  read("index.html"),
  read("css/style.css"),
  read("js/data.js"),
  read("js/engine.js"),
  read("js/app.js"),
]);

// 注意：替换字符串里可能出现 $$ / $& 等字符（例如 app.js 中的 $$
// 选择器辅助函数），必须使用函数形式替换，避免 String.replace 的
// 美元符号替换语义破坏源码。
let output = html
  .replace(
    /<link rel="stylesheet" href="css\/style\.css" \/>/,
    () => `<style>\n${css}\n</style>`
  )
  .replace(
    /<script src="js\/data\.js"><\/script>/,
    () => `<script>\n${escapeInline(data)}\n</script>`
  )
  .replace(
    /<script src="js\/engine\.js"><\/script>/,
    () => `<script>\n${escapeInline(engine)}\n</script>`
  )
  .replace(
    /<script src="js\/app\.js"><\/script>/,
    () => `<script>\n${escapeInline(app)}\n</script>`
  );

output = output.replace(
  "<!DOCTYPE html>",
  `<!DOCTYPE html>\n<!-- 天机三彩 · 单文件离线版，由 index.html + css + js 内联生成。数据截止 2026-11-05。 -->`
);

const target = path.join(ROOT, "天机三彩.html");
await fs.writeFile(target, output, "utf8");
const size = Buffer.byteLength(output, "utf8");
const remainingAssets = [...output.matchAll(/(?:src|href)="((?!data:|#|https?:)[^"]+)"/g)].map((m) => m[1]);
console.log(`单文件已生成：${target}`);
console.log(`大小：${(size / 1024).toFixed(1)} KB`);
console.log(`残留外部资源引用：${remainingAssets.length ? remainingAssets.join(", ") : "无"}`);
