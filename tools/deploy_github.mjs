/**
 * 一次性的 GitHub Pages 发布脚本
 *
 * 前置：
 *   gh auth login --scopes "repo,workflow,read:org"
 *   $env:GH_TOKEN = (gh auth token)
 *
 * 运行：node tools/deploy_github.mjs
 * 可选：REPO_NAME=sancai-oracle、SKIP_UPDATE_TEST=1
 *
 * 使用 GitHub Git Data API 直接创建仓库并上传文件，不依赖本机 git。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("缺少 GH_TOKEN。请先运行：$env:GH_TOKEN = (gh auth token)");
  process.exit(1);
}
const API = "https://api.github.com";
const DEFAULT_REPO = process.env.REPO_NAME || "sancai-oracle";
const SKIP_UPDATE_TEST = process.env.SKIP_UPDATE_TEST === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let requestCount = 0;
async function api(method, endpoint, body, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : API + endpoint;
  requestCount++;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sancai-oracle-deploy",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    if (options.allow && options.allow.includes(response.status)) {
      return { ok: false, status: response.status, data };
    }
    const message = data?.message || data || "";
    const error = new Error(`${method} ${endpoint} -> HTTP ${response.status}: ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { ok: true, status: response.status, data, headers: response.headers };
}

async function collectFiles() {
  const roots = [".github", "css", "js", "site", "screenshots", "tools"];
  const files = [];
  const skipFile = new Set(["sancai-online-github.zip"]);
  async function walkDir(relDir) {
    const entries = await fs.readdir(path.join(ROOT, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.posix.join(relDir, entry.name);
      if (entry.name.startsWith(".tmp") || entry.name === "screenshots-online") continue;
      if (entry.isDirectory()) {
        await walkDir(rel);
      } else if (entry.isFile() && !skipFile.has(rel)) {
        files.push(rel);
      }
    }
  }
  for (const root of roots) {
    try {
      await walkDir(root);
    } catch {}
  }
  for (const file of ["index.html", "天机三彩.html", "README.md", "ONLINE.md", ".gitignore", "data.json"]) {
    try {
      const stat = await fs.stat(path.join(ROOT, file));
      if (stat.isFile()) files.push(file);
    } catch {}
  }
  files.sort();
  return files;
}

async function createRepo(owner) {
  let name = DEFAULT_REPO;
  for (let suffix = 2; suffix <= 6; suffix++) {
    process.stdout.write(`检查仓库 ${owner}/${name} ... `);
    const existing = await api("GET", `/repos/${owner}/${name}`, null, { allow: [404] });
    if (existing.status === 404) {
      console.log("可用");
      break;
    }
    if (existing.data?.owner?.login === owner && Number(existing.data.size) === 0) {
      console.log("已存在且为空，直接复用");
      return existing.data;
    }
    console.log("已存在且有内容，尝试下一个名字");
    name = `${DEFAULT_REPO}-${suffix}`;
  }
  const created = await api("POST", "/user/repos", {
    name,
    description: "天机三彩 · 大乐透/双色球/快乐8 统计选号终端（GitHub Pages 自动更新）",
    private: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    auto_init: false,
  });
  console.log(`仓库已创建：${created.data.html_url}`);
  return created.data;
}

async function ensureInitialized(owner, repo) {
  // 空仓库不能直接创建 blob/tree；先用 Contents API 创建一次初始化提交。
  let repoInfo = await api("GET", `/repos/${owner}/${repo}`);
  let branch = repoInfo.data.default_branch || "main";
  let ref = await api("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`, null, { allow: [404, 409] });
  if (!ref.ok) {
    console.log("空仓库，先创建初始化提交 ...");
    await api("PUT", `/repos/${owner}/${repo}/contents/README.md`, {
      message: "chore: initialize repository",
      content: Buffer.from("# 天机三彩\n\n正在初始化在线版本。\n", "utf8").toString("base64"),
    });
    for (let i = 0; i < 20; i++) {
      repoInfo = await api("GET", `/repos/${owner}/${repo}`);
      branch = repoInfo.data.default_branch || "main";
      ref = await api("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`, null, { allow: [404, 409] });
      if (ref.ok) break;
      await sleep(1000);
    }
  }
  if (!ref.ok) throw new Error("仓库初始化失败，无法取得默认分支");
  await api("PATCH", `/repos/${owner}/${repo}`, { default_branch: branch });
  console.log(`默认分支：${branch}，基线提交：${ref.data.object.sha.slice(0, 8)}`);
  return { branch, baseSha: ref.data.object.sha };
}

async function uploadFiles(owner, repo, files) {
  console.log(`准备上传 ${files.length} 个文件 ...`);
  const blobs = [];
  let done = 0;
  for (const file of files) {
    const buffer = await fs.readFile(path.join(ROOT, file));
    const result = await api("POST", `/repos/${owner}/${repo}/git/blobs`, {
      content: buffer.toString("base64"),
      encoding: "base64",
    });
    blobs.push({ path: file, sha: result.data.sha, size: buffer.length });
    done++;
    if (done % 8 === 0 || done === files.length) process.stdout.write(`\r  上传 blob ${done}/${files.length}`);
    await sleep(40);
  }
  process.stdout.write("\n");
  return blobs;
}

async function createInitialCommit(owner, repo, blobs, branch, baseSha) {
  const treeEntries = blobs.map((blob) => ({
    path: blob.path,
    mode: "100644",
    type: "blob",
    sha: blob.sha,
  }));
  const tree = await api("POST", `/repos/${owner}/${repo}/git/trees`, {
    tree: treeEntries,
  });
  const commit = await api("POST", `/repos/${owner}/${repo}/git/commits`, {
    message: "feat: 天机三彩在线版首次发布（PWA + 自动更新）",
    tree: tree.data.sha,
    parents: baseSha ? [baseSha] : [],
    author: {
      name: owner,
      email: `${owner}@users.noreply.github.com`,
      date: new Date().toISOString(),
    },
    committer: {
      name: owner,
      email: `${owner}@users.noreply.github.com`,
      date: new Date().toISOString(),
    },
  });
  await api("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    sha: commit.data.sha,
    force: true,
  });
  await api("PATCH", `/repos/${owner}/${repo}`, { default_branch: branch });
  console.log(`提交完成：${commit.data.sha.slice(0, 8)}`);
  return commit.data;
}

async function enablePages(owner, repo) {
  console.log("启用 GitHub Pages（GitHub Actions 源）...");
  const result = await api("POST", `/repos/${owner}/${repo}/pages`, { build_type: "workflow" }, { allow: [409, 422] });
  if (!result.ok) {
    console.log(`Pages 创建返回 HTTP ${result.status}，尝试读取当前配置 ...`);
    const current = await api("GET", `/repos/${owner}/${repo}/pages`, null, { allow: [404] });
    if (current.status === 404) {
      throw new Error("无法启用 Pages：请确认账号邮箱已验证，或在仓库 Settings → Pages 手动选择 GitHub Actions。");
    }
  }
  const pages = await api("GET", `/repos/${owner}/${repo}/pages`, null, { allow: [404] });
  console.log("Pages 配置：", pages.data?.html_url || pages.data?.build_type || "已启用");
}

async function findWorkflow(owner, repo, displayName, workflowPath) {
  for (let i = 0; i < 30; i++) {
    const result = await api("GET", `/repos/${owner}/${repo}/actions/workflows`);
    const workflow = result.data.workflows.find(
      (item) => item.name === displayName || item.path === workflowPath
    );
    if (workflow) return workflow;
    await sleep(2000);
  }
  throw new Error(`未找到工作流：${displayName}`);
}

async function dispatchAndWait(owner, repo, workflow, label, branch, timeoutMs = 600000) {
  console.log(`触发工作流：${label} ...`);
  const startedAt = Date.now();
  await api("POST", `/repos/${owner}/${repo}/actions/workflows/${workflow.id}/dispatches`, {
    ref: branch,
  });
  let run = null;
  for (let i = 0; i < 60; i++) {
    const result = await api("GET", `/repos/${owner}/${repo}/actions/workflows/${workflow.id}/runs?per_page=10`);
    run = result.data.workflow_runs.find(
      (item) => new Date(item.created_at).getTime() >= startedAt - 10000
    );
    if (run) break;
    await sleep(2000);
  }
  if (!run) throw new Error(`${label} 未找到运行记录`);
  console.log(`运行地址：${run.html_url}`);
  while (Date.now() - startedAt < timeoutMs) {
    const result = await api("GET", `/repos/${owner}/${repo}/actions/runs/${run.id}`);
    run = result.data;
    process.stdout.write(`\r  状态：${run.status} / ${run.conclusion || "…"}   `);
    if (run.status === "completed") {
      process.stdout.write("\n");
      if (run.conclusion !== "success") {
        const jobs = await api("GET", `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`);
        for (const job of jobs.data.jobs) {
          console.log(`  job ${job.name}: ${job.conclusion}`);
          for (const step of job.steps || []) {
            if (step.conclusion && step.conclusion !== "success") {
              console.log(`    - ${step.name}: ${step.conclusion}`);
            }
          }
        }
        throw new Error(`${label} 失败：${run.conclusion}（${run.html_url}）`);
      }
      console.log(`${label} 成功`);
      return run;
    }
    await sleep(4000);
  }
  throw new Error(`${label} 超时`);
}

async function waitForSite(url, timeoutMs = 240000) {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "sancai-oracle-check" } });
      const body = await response.text();
      lastStatus = `${response.status} / ${body.length} bytes`;
      if (response.ok && body.includes("天机三彩")) {
        console.log(`\n线上地址可访问：${url}`);
        return true;
      }
    } catch (error) {
      lastStatus = error.message;
    }
    process.stdout.write(`\r  等待 Pages 生效：${lastStatus}   `);
    await sleep(6000);
  }
  console.log("");
  return false;
}

(async () => {
  console.log(`GitHub 发布开始，API：${API}`);
  const user = await api("GET", "/user");
  const owner = user.data.login;
  const repoData = await createRepo(owner);
  const repo = repoData.name;
  const init = await ensureInitialized(owner, repo);
  const files = await collectFiles();
  const blobs = await uploadFiles(owner, repo, files);
  await createInitialCommit(owner, repo, blobs, init.branch, init.baseSha);
  await enablePages(owner, repo);

  const deployWorkflow = await findWorkflow(
    owner,
    repo,
    "Deploy Current Snapshot",
    ".github/workflows/deploy-current.yml"
  );
  await dispatchAndWait(owner, repo, deployWorkflow, "首次快照发布", init.branch);

  const url = `https://${owner}.github.io/${repo}/`;
  const live = await waitForSite(url);
  await api("PATCH", `/repos/${owner}/${repo}`, { homepage: url });

  if (!SKIP_UPDATE_TEST) {
    try {
      const updateWorkflow = await findWorkflow(
        owner,
        repo,
        "Auto Update & Deploy Pages",
        ".github/workflows/update-pages.yml"
      );
      await dispatchAndWait(owner, repo, updateWorkflow, "自动更新（抓取官网）测试", init.branch);
    } catch (error) {
      console.log(`\n自动更新测试未通过：${error.message}`);
      console.log("页面会保留首次发布的版本；需要境内服务器或自托管 Runner 才能稳定抓取中国官网。");
    }
  }

  console.log(`\n===== RESULT =====`);
  console.log(`owner: ${owner}`);
  console.log(`repo:  ${owner}/${repo}`);
  console.log(`url:   ${url}`);
  console.log(`live:  ${live}`);
  console.log(`api_calls: ${requestCount}`);
})().catch((error) => {
  console.error("\n发布失败：", error.message);
  if (error.data) console.error(JSON.stringify(error.data, null, 2).slice(0, 4000));
  process.exitCode = 1;
});
