export const meta = {
  name: "daily-review",
  description: "每日训练复盘：从 COROS 采集数据 → LLM 分析 → 数据验证 → HTML 报告",
  phases: [
    { title: "数据采集", detail: "从 COROS MCP 获取最新训练数据" },
    { title: "深度分析", detail: "LLM 深度复盘 + 训练计划生成" },
    { title: "数据验证", detail: "验证分析结果的配速趋势、周跑量统计等数据一致性" },
    { title: "报告生成", detail: "生成 HTML 可视化报告并打开" },
  ],
};

// Support --date YYYYMMDD via args
const dateArg = args?.date ? `--date ${args.date}` : "";

phase("数据采集");
log("正在从 COROS 获取最新训练数据...");
const fetchResult = await agent(
  `运行 COROS 数据采集脚本。

  执行: node scripts/fetch.js ${dateArg}
  确认脚本 exit code 为 0。

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

  执行: node scripts/analyze.js --force --date ${dateStr}
  确认脚本 exit code 为 0。

  预期输出：
  - 控制台打印详细的训练复盘 Markdown
  - data/daily/${dateStr}-analysis.json 已生成（包含 workoutReviews、bodyAssessment 等字段）

  不需要返回内容，确认成功即可。`,
  { label: "analyze" },
);

phase("数据验证");
log("正在验证分析结果的准确性...");
const verification = await agent(
  `验证训练分析结果的数据一致性。

  读取以下文件：
  1. data/daily/${dateStr}.json（COROS 原始数据）
  2. data/daily/${dateStr}-analysis.json（LLM 分析结果）

  检查以下项目：
  分析 JSON 中 tcxSummary 字段，格式如 "负分段加速(X:XX→X:XX)" 或 "后程掉速(X:XX→X:XX)"。
  - 配速数值 = 每公里用时（秒），数值越大越慢
  - "负分段加速" = 首公里配速 > 末公里配速（首公里慢末公里快，越跑越快）
  - "后程掉速" = 首公里配速 < 末公里配速（首公里快末公里慢，越跑越慢）
  - 检查标签与实际数值方向是否一致

  **2. 周跑量统计**
  - 周周期应为周一→周日
  - 检查 weeklySummary.totalKm 是否匹配该周期内的活动记录

  **3. 数据一致性**
  - bodyAssessment 中引用的 HRV/恢复/睡眠数值与 raw data 是否基本一致
  - weeklyPlan 中的日期是否从今天开始正确

  输出检查报告。`,
  {
    label: "verify",
    model: "haiku",
    schema: {
      type: "object",
      properties: {
        report: {
          type: "object",
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  severity: { type: "string", enum: ["error", "warning", "info"] },
                  category: { type: "string" },
                  description: { type: "string" },
                },
                required: ["severity", "category", "description"],
              },
            },
            hasIssues: { type: "boolean" },
            summary: { type: "string" },
          },
          required: ["issues", "hasIssues", "summary"],
        },
      },
      required: ["report"],
    },
  },
);

if (verification.report.hasIssues) {
  const errors = verification.report.issues.filter((i) => i.severity === "error");
  const warnings = verification.report.issues.filter((i) => i.severity === "warning");
  if (errors.length > 0) {
    log(`⚠️ 发现 ${errors.length} 个错误：${errors.map((e) => `[${e.category}] ${e.description}`).join("；")}`);
  }
  if (warnings.length > 0) {
    log(`⚠️  ${warnings.length} 个警告：${warnings.map((w) => `[${w.category}] ${w.description}`).join("；")}`);
  }
  log(`验证摘要：${verification.report.summary}`);
} else {
  log(`✅ 验证通过：${verification.report.summary}`);
}

phase("报告生成");
log("正在生成 HTML 可视化报告...");
await agent(
  `生成并打开可视化报告。

  依次执行：
  1. node scripts/report.js --date ${dateStr}
  2. open reports/${dateStr}-report.html

  确认两个命令都成功执行。`,
  { label: "report" },
);

log(`✅ 训练复盘流程完成！报告：reports/${dateStr}-report.html`);
if (verification.report.hasIssues) {
  log(`📋 验证发现了 ${verification.report.issues.length} 个问题，建议查看报告确认。`);
}
