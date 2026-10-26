import { chromium } from "playwright";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendObservations, articleIdentity, cleanText, extractObservations, makeReport, responseSource, statisticsResponseDiagnostic } from "./observations.mjs";

const help = `用法：npm --prefix seagull-ui run wechat:check -- [--article-url '文章链接'] [--account-label '账号备注']
未提供参数时将在终端询问。不需要 AppSecret、API Key 或粘贴 Cookie。
将打开独立临时浏览器：本人扫码登录，手动进入目标文章的已发表列表或数据页。
工具仅监听页面自然返回的数据，不自动点击、请求统计接口、发布或删除。
浏览器登录态仍拥有账号权限，请勿在该窗口执行发布等写操作。
输入 查看、诊断、保存、退出；最多等待 15 分钟。保存的是待核对报告，不会写入 Seagull 快照。`;

function showObservations(observations) {
  if (!observations.length) {
    console.log("尚未识别目标文章。请手动打开对应列表/数据页；短链和长链不能凭标题自动关联。页面结构变化也会导致无法识别，不代表数据为零。");
    return;
  }
  observations.forEach((observation, index) => {
    console.log(`\n记录 ${index + 1} · ${observation.observed_at} · ${observation.source_endpoint} · ${observation.diagnostics.row_source} · ${observation.title}`);
    for (const [name, value] of Object.entries(observation.metrics)) {
      console.log(`  ${name}: ${value === null ? "未知" : value}`);
    }
    if (observation.capture_status === "article_matched_no_supported_metrics") {
      console.log("  仅文章匹配成功，尚未读到可用统计值。这不是零阅读，也不能据此判断账号没有权限。请手动打开后台文章的数据统计页，再输入 诊断。");
    }
  });
  console.log("字段含义、人数/次数、统计区间均待后台核对；不同响应不合并、不相加。不是播客播放量。");
}

function showDiagnostics(observations, requestDiagnostics) {
  console.log("安全结构诊断：仅字段名、类型与解析状态，不包含字段原始值、Cookie、token 或完整响应。appmsg_info 数组仅抽样展示结构；未精确绑定目标文章的响应绝不并入统计。");
  if (!observations.length) showObservations(observations);
  observations.forEach((observation, index) => {
    console.log(`\n记录 ${index + 1} · ${observation.source_endpoint} · ${observation.capture_status}`);
    console.log(`  来源 ${observation.diagnostics.row_source} · 关联方式 ${observation.diagnostics.article_match}`);
    for (const [name, status] of Object.entries(observation.diagnostics.metric_fields)) {
      console.log(`  ${name}: ${status}`);
    }
    for (const scope of ["article_fields", "publication_fields", "publication_article_info_fields", "page_fields", "response_fields"]) {
      console.log(`  ${scope}:`);
      for (const field of observation.diagnostics[scope]) console.log(`    ${field.path}: ${field.type}`);
    }
  });
  if (!requestDiagnostics.length) console.log("\n尚未观察到 /misc/appmsganalysis 的统计页面响应；其他统计端点暂未支持。请确认打开了公众号后台的数据统计页，而不是文章正文。");
  for (const diagnostic of requestDiagnostics) {
    console.log(`\n统计页面响应（未绑定文章，仅结构）：${diagnostic.endpoint} · action=${diagnostic.action} · ${diagnostic.status}`);
    for (const field of diagnostic.fields) console.log(`  ${field.path}: ${field.type}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    "article-url": { type: "string" }, "account-label": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) return console.log(help);
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("interactive_terminal_required");
  const terminal = createInterface({ input: stdin, output: stdout });
  const shutdown = new AbortController();
  let browser;
  let timeout;
  const stop = () => {
    shutdown.abort();
    void browser?.close().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const target = articleIdentity(values["article-url"] || (await terminal.question("请输入自己已发表的一篇文章链接：", { signal: shutdown.signal })));
    const accountLabel = cleanText(values["account-label"] || (await terminal.question("账号备注（仅本地标记，不验证账号身份）：", { signal: shutdown.signal })), 80);
    if (!accountLabel) throw new Error("account_label_required");
    if (shutdown.signal.aborted) return;
    console.log(help);
    browser = await chromium.launch({ headless: false });
    if (shutdown.signal.aborted) return;
    browser.once("disconnected", stop);
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    let observations = [];
    const requestDiagnostics = [];
    const rememberRequestDiagnostic = diagnostic => {
      if (requestDiagnostics.some(previous => JSON.stringify(previous) === JSON.stringify(diagnostic))) return;
      requestDiagnostics.push(diagnostic);
      if (requestDiagnostics.length > 10) requestDiagnostics.shift();
      console.log("\n已观察到统计页面响应；尚未绑定文章的数据仅记录结构或 HTTP 状态，不作为统计结果。输入 诊断 查看。");
    };
    const pending = new Set();
    let malformedNotice = false;
    let accepting = true;
    const collect = async response => {
      const source = responseSource(response.url());
      const probe = statisticsResponseDiagnostic(null, response.url());
      if (!source && !probe) return;
      if (response.status() !== 200) {
        if (probe) rememberRequestDiagnostic({ ...probe, status: `http_${response.status()}` });
        return;
      }
      const headers = response.headers();
      if (Number(headers["content-length"]) > 2 * 1024 * 1024) return;
      try {
        const body = await response.body();
        if (!accepting || body.byteLength > 2 * 1024 * 1024) return;
        const text = body.toString("utf8");
        if (probe) {
          rememberRequestDiagnostic(statisticsResponseDiagnostic(text, response.url()));
        }
        if (!source) return;
        const found = extractObservations(text, source, target.url, new Date().toISOString());
        const updated = appendObservations(observations, found);
        observations = updated.observations;
        if (updated.added) {
          console.log(`\n已识别目标文章，现有 ${observations.length} 条不同的待核对记录（最多保留最近 20 条）。输入 查看 显示字段，输入 诊断 定位结构。`);
          if (found.every(observation => observation.capture_status === "article_matched_no_supported_metrics")) {
            console.log("文章匹配成功，但尚未获取可用统计值；请打开后台数据统计页，不是公众号文章正文。不要把此提示视为统计获取成功。");
          }
        }
      } catch {
        if (!malformedNotice && accepting) {
          malformedNotice = true;
          console.log("\n有候选响应无法识别；未记录原始响应，不补零、不自动重试。");
        }
      }
    };
    const listener = response => {
      if (!accepting || pending.size >= 4) return;
      const task = collect(response).catch(() => {});
      pending.add(task);
      void task.finally(() => pending.delete(task));
    };
    context.on("response", listener);
    const page = await context.newPage();
    timeout = setTimeout(stop, 15 * 60 * 1000);
    await page.goto("https://mp.weixin.qq.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("请在新窗口扫码登录并手动打开目标文章的数据。不要发送 Cookie；关闭窗口也会退出。");
    while (!shutdown.signal.aborted) {
      const command = (await terminal.question("查看 / 诊断 / 保存 / 退出 > ", { signal: shutdown.signal })).trim();
      if (command === "退出") break;
      if (command === "查看") showObservations(observations);
      if (command === "诊断") showDiagnostics(observations, requestDiagnostics);
      if (command === "保存") {
        accepting = false;
        context.off("response", listener);
        await Promise.allSettled([...pending]);
        showObservations(observations);
        if (!observations.length) {
          accepting = true;
          context.on("response", listener);
          continue;
        }
        const confirm = await terminal.question("仅保存待核对字段及无原始值的结构诊断（不是已验证快照），输入 保存 确认：", { signal: shutdown.signal });
        if (confirm.trim() !== "保存") {
          accepting = true;
          context.on("response", listener);
          continue;
        }
        const directory = await mkdtemp(join(tmpdir(), "seagull-wechat-check-"));
        await chmod(directory, 0o700);
        const reportPath = join(directory, "report.json");
        await writeFile(reportPath, JSON.stringify(makeReport(accountLabel, target.url, observations, requestDiagnostics), null, 2), { mode: 0o600, flag: "wx" });
        console.log(`待核对报告保存于 ${reportPath}。未保存 Cookie/token、完整响应或浏览器登录态；报告不上传、不入库。`);
        break;
      }
    }
  } catch (error) {
    if (error.name !== "AbortError" && !shutdown.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
    terminal.close();
    await browser?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(() => {
  console.error("验证未完成。请检查文章链接、账号备注、交互终端、图形桌面和 Playwright Chromium 安装，以及微信后台是否可访问；未输出原始错误以免泄露登录信息。使用 --help 查看说明。");
  process.exitCode = 1;
});
