export const meta = {
  name: "daily-review",
  description: "每日训练复盘：从 COROS 采集数据 → LLM 分析 → 数据验证 → 计划推送 → HTML 报告",
  phases: [
    { title: "选择 LLM", detail: "选择本次分析使用的 LLM 提供商" },
    { title: "数据采集", detail: "从 COROS MCP 获取最新训练数据" },
    { title: "深度分析", detail: "LLM 深度复盘 + 训练计划生成" },
    { title: "数据验证", detail: "验证分析结果的配速趋势、周跑量统计等数据一致性" },
    { title: "计划推送", detail: "将 AI 生成的周计划推送到 COROS 手表日历" },
    { title: "报告生成", detail: "生成 HTML 可视化报告并打开" },
  ],
};

// Support --date YYYYMMDD via args
const dateArg = args?.date ? `--date ${args.date}` : "";

phase("选择 LLM");
let selectedProvider = args?.provider || null;
if (!selectedProvider) {
  const providerChoice = await agent(
    `请询问用户本次分析使用哪个 LLM 提供商。当前可用:
    - deepseek: DeepSeek 原生 API
    返回用户选择的提供商名称。`,
    {
      label: "provider-select",
      schema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["deepseek"] },
        },
        required: ["provider"],
      },
    },
  );
  selectedProvider = providerChoice.provider;
}
log(`LLM 提供商: ${selectedProvider}`);

phase("数据采集");
log("正在从 COROS 获取最新训练数据...");
const fetchResult = await agent(
  `运行 COROS 数据采集脚本。

  执行: node scripts/fetch.js ${dateArg}
  查看 stderr 最后一行，若为 STATUS:OK 则成功，否则失败。

  采集完成后，获取本次数据的日期（YYYYMMDD 格式）。
  - 如果传入了 --date 参数，使用该日期
  - 否则执行 bash date +%Y%m%d 获取今天日期

  返回日期和运行状态。`,
  {
    label: "fetch",
    schema: {
      type: "object",
      properties: {
        date: { type: "string" },
        status: { type: "string" },
      },
      required: ["date", "status"],
    },
  },
);

const dateStr = fetchResult.date;
log(`数据日期: ${dateStr}`);

phase("深度分析");
log("正在进行 LLM 深度训练复盘...");
await agent(
  `运行训练分析脚本。

  执行: node scripts/analyze.js --force --date ${dateStr} --provider ${selectedProvider}
  查看 stderr 最后一行，若为 STATUS:OK 则成功，否则失败。

  预期输出：
  - 控制台打印详细的训练复盘 Markdown
  - data/daily/${dateStr}-analysis.json 已生成（包含 workoutReviews、bodyAssessment 等字段）

  不需要返回内容，确认成功即可。`,
  { label: "analyze" },
);

phase("数据验证");
log("运行数据验证脚本...");
const verifyResult = await agent(
  `运行数据一致性验证脚本。

  执行: node scripts/validate.js --date ${dateStr}
  查看 stderr 最后一行，若为 STATUS:OK 则成功，否则失败。
  从 stdout 获取输出的 JSON 结果。

  将 JSON 中的 issues 数组、hasIssues 布尔值、summary 字符串直接返回。`,
  {
    label: "verify",
    model: "haiku",
    schema: {
      type: "object",
      properties: {
        issues: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, category: { type: "string" }, description: { type: "string" } } } },
        hasIssues: { type: "boolean" },
        summary: { type: "string" },
      },
    },
  },
);

if (verifyResult.hasIssues) {
  const errors = verifyResult.issues.filter((i) => i.severity === "error");
  const warnings = verifyResult.issues.filter((i) => i.severity === "warning");
  if (errors.length > 0) {
    log(`⚠️ 发现 ${errors.length} 个错误：${errors.map((e) => `[${e.category}] ${e.description}`).join("；")}`);
  }
  if (warnings.length > 0) {
    log(`⚠️  ${warnings.length} 个警告：${warnings.map((w) => `[${w.category}] ${w.description}`).join("；")}`);
  }
  log(`验证摘要：${verifyResult.summary}`);
} else {
  log(`✅ 验证通过：${verifyResult.summary}`);
}

phase("计划推送");
log("正在将 AI 生成的周计划推送到 COROS 手表...");
const pushResult = await agent(
  `将训练计划推送到 COROS 手表日历。

  执行: scripts/push-plan.py --date ${dateStr}
  先查看预览输出，确认无误后如果用户确认，执行:
    scripts/push-plan.py --date ${dateStr} --confirm

  查看 stdout，若包含 "推送完成" 则成功。如果出现认证错误，提示用户检查 COROS 账号配置。

  注意：使用 Python 脚本 scripts/push-plan.py（不是 push-plan.js）。`,
  { label: "push-plan" },
);

phase("报告生成");
log("正在生成 HTML 可视化报告...");
await agent(
  `生成并打开可视化报告。

  依次执行：
  1. node scripts/report.js --date ${dateStr}
     查看 stderr 最后一行，若为 STATUS:OK 则成功
  2. node scripts/report-list.js
     刷新门户页面
  3. open reports/${dateStr}-report.html
     确认打开成功

  确认所有命令都成功执行。`,
  { label: "report" },
);

log(`✅ 训练复盘流程完成！报告：reports/${dateStr}-report.html`);
if (verifyResult.hasIssues) {
  log(`📋 验证发现了 ${verifyResult.issues.length} 个问题，建议查看报告确认。`);
}
