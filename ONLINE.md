# 天机三彩 · 在线版 / 手机版部署说明

在线版 = 同一套「天机三彩」界面 + **PWA 安装能力** + **GitHub Pages 自动更新**。

上线后：

- 手机浏览器打开网址即可使用，不需要安装 APK；
- 可以「添加到主屏幕」，像 App 一样全屏打开；
- 每天开奖后，GitHub Actions 自动抓取官方数据、重建页面并发布；
- 收藏仍然只保存在当前手机浏览器，不需要注册账号；
- 页面本身是静态 HTML，没有后端、没有数据库、没有追踪脚本。

> 当前工作区已经准备好全部文件，但**还没有推送到任何公开账号**。需要一个 GitHub 仓库才能生成公开网址。

---

## 一、最快上线：GitHub Pages（免费）

### 0. 准备

- 一个 GitHub 账号；
- 一台电脑（网页版即可，不需要安装 Git）；
- 仓库建议设为 **Public**（免费账号的 Pages 通常要求公开仓库）。

### 1. 新建仓库

GitHub → New repository：

- Repository name：`sancai-oracle`（可自定义）
- Visibility：**Public**
- 不要勾选 “Add a README file”，保持空仓库。

### 2. 上传项目

推荐用 **GitHub Desktop**：

1. 解压 `sancai-online-github.zip`；
2. GitHub Desktop → File → Add local repository，选择解压后的文件夹；
3. Publish repository；
4. 确保仓库根目录能看到 `index.html`、`tools/`、`site/`、`.github/`。

如果只用网页上传：

1. 解压后，在 GitHub 仓库页点 **Add file → Upload files**；
2. 把项目里的**所有文件和文件夹**拖进去（不是外层 `lottery-oracle` 文件夹本身）；
3. `.github` 是隐藏文件夹，网页拖拽可能漏掉。若漏掉，进入 **Add file → Create new file**，文件名填 `.github/workflows/update-pages.yml`，把本项目的同名文件内容粘贴进去；
4. Commit。

### 3. 开启 Pages

仓库 → **Settings → Pages**：

- Build and deployment → Source：**GitHub Actions**。

注意：工作流**不会**自动开启 Pages（默认 `GITHUB_TOKEN` 没有开启权限），所以这一步必须先手动完成。开启后再运行 Actions。

### 4. 第一次发布

仓库 → **Actions** → 左侧 **Deploy Current Snapshot** → **Run workflow**。

这一步不联网抓数据，直接使用仓库里的当前数据发布，最容易成功。等 1–2 分钟后：

```
https://<你的GitHub用户名>.github.io/<仓库名>/
```

这个地址就是手机访问地址。

接着可以手动运行一次 **Auto Update & Deploy Pages**，测试自动抓取是否正常。

### 5. 添加到手机主屏幕

**iPhone / Safari：**

1. 打开网址；
2. 点底部「分享」；
3. 选「添加到主屏幕」；
4. 命名为「天机三彩」。

**Android / Chrome：**

1. 打开网址；
2. 右上角菜单；
3. 选「安装应用」或「添加到主屏幕」。

之后从桌面图标打开，会以独立窗口运行，接近原生 App。

---

## 二、自动更新机制

工作流文件：`.github/workflows/update-pages.yml`

- 触发：
  - 每天 **22:40** 与 **23:40**（中国标准时间）两次定时；
  - 也可以在 Actions 页面手动 `Run workflow`；
  - 修改代码后如果希望立即更新，手动运行一次即可。
- 流程：
  1. `node tools/fetch_data.mjs`：抓取中国福彩官网 + 500彩票网历史开奖；
  2. `node tools/build_single.mjs`：重建离线单文件；
  3. `node tools/build_online.mjs`：生成 `site/index.html` 和 PWA 资源；
  4. `node tools/engine.test.mjs`：1630+ 项引擎断言；
  5. 上传 `site/` 到 GitHub Pages。

开奖后通常 1 小时内更新。GitHub 的定时任务可能延迟，不是毫秒级实时。

### 关于海外 Runner 的重要提醒

GitHub Actions 的机器在海外。中国福彩官网 / 500彩票网如果限制海外 IP，抓取步骤会失败，站点会保留上一版数据（不会部署脏数据）。

第一次部署后，请打开 Actions 日志确认：

- `Fetch latest official draw data` 成功；
- `DATA AS OF ...` 打印出最新日期。

如果失败，可选：

1. **境内服务器方案**：在阿里云/腾讯云/自己电脑上每天运行 `fetch_data.mjs + build_single.mjs + build_online.mjs`，把 `site/` 发布到任意静态托管；
2. **境内 CI**：使用 Gitee / 自建 Jenkins 等可访问境内官网的构建环境；
3. **手动兜底**：在本机运行上述命令，再用 GitHub Desktop 把更新后的 `site/` 推上去。

---

## 三、本地 / 局域网预览

没有公网仓库时，也可以先在手机上看效果（电脑和手机必须同一 Wi-Fi）：

```bash
node tools/serve_online.mjs
```

终端会打印类似：

```
本机：   http://localhost:8080/
手机同一 Wi-Fi： http://192.168.x.x:8080/
```

手机打开局域网地址即可。注意：

- 电脑必须保持开机且脚本运行；
- Windows 防火墙可能会拦截，首次运行请允许 Node.js；
- 这不是公网在线版，离开同一 Wi-Fi 就无法访问。

---

## 四、自己的服务器 / 自定义域名

### 静态托管

把 `site/` 目录整个上传到任意静态托管（Nginx、OSS、COS、Netlify、Vercel 等）即可。

- 必须使用 **HTTPS**，PWA / Service Worker 才能在手机上正常安装；
- 站点根路径或子路径都行，`manifest` 与 `sw.js` 使用相对路径；
- 用 Nginx 时不要缓存 `sw.js`，或至少让 `index.html` 使用短缓存。

### 自动更新

在可以访问中国福彩/500彩票网的服务器上配置定时任务：

```cron
40 22 * * * cd /path/to/lottery-oracle && /usr/bin/node tools/fetch_data.mjs && /usr/bin/node tools/build_single.mjs && /usr/bin/node tools/build_online.mjs && cp -r site/* /var/www/sancai/
```

然后给站点配置 HTTPS 和域名，手机访问域名即可。

---

## 五、常见问题

**Q：打开网址显示 404？**  
A：确认 Pages → Source 是 GitHub Actions，且 Actions 里的部署任务成功。仓库根目录必须有 `site/`，工作流会把它作为发布产物。

**Q：Actions 报权限错误？**  
A：Settings → Actions → General → Workflow permissions 选择 “Read and write permissions”，并确认 Pages 的 Source 是 GitHub Actions。

**Q：数据没有更新？**  
A：先看 Actions 最近一次运行是否成功；再在手机上强制刷新 / 重新打开 PWA。Service Worker 对页面使用 network-first，正常联网会拿最新版本。

**Q：收藏会同步到另一台手机吗？**  
A：不会。收藏保存在浏览器 localStorage，属于本机数据；没有账号系统，也不上传服务器。

**Q：能保证“开奖瞬间实时”吗？**  
A：不能。当前方案是每天开奖后定时构建，属于准实时。要做到秒级，需要自建后端实时查询官方接口，成本和稳定性都更高。

**Q：以后官方接口改版怎么办？**  
A：只需要修改 `tools/fetch_data.mjs` 的抓取解析逻辑，重新部署；前端和引擎不需要动。

---

## 六、安全与隐私

- 页面无登录、无账号、无数据库；
- 无第三方统计、无广告、无追踪脚本；
- 收藏只在浏览器本地；
- 唯一的外部请求是构建时由 GitHub Actions 抓取官方开奖数据；用户打开页面时不请求任何第三方接口。

---

## 七、最短路径总结

1. 解压 `sancai-online-github.zip`；
2. 推到 GitHub 空仓库（Public）；
3. Settings → Pages → Source = GitHub Actions；
4. Actions → Run workflow；
5. 手机打开 `https://<用户名>.github.io/<仓库名>/`；
6. Safari/Chrome 添加到主屏幕。
