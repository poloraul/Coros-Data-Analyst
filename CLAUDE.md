# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Coros Data Analyst — 基于高驰 MCP 数据的训练自动复盘与计划系统。

用户目标：2026年12月初首马，目标 3:30 以内。

## Environment

- MCP: Puppeteer server is enabled for browser automation tasks
- MCP: Coros server is enabled for training data access

## 训练复盘指令

当用户要求复盘、训练分析、训练计划、恢复评估时，优先使用 Workflow 一键执行。

### Workflow 一键执行（推荐）

`Workflow({name: "daily-review"})` — 自动完成采集→分析→验证→报告

若按名称找不到，用 `scriptPath` 指定：
`Workflow({scriptPath: ".claude/workflows/daily-review.js"})`

**支持参数**：
- `Workflow({name: "daily-review", args: {date: "20260525"}})` — 指定日期
- `Workflow({name: "daily-review", args: {provider: "volcengine"}})` — 指定 LLM 提供商（跳过交互选择）
- `Workflow({name: "daily-review", args: {date: "20260525", provider: "volcengine"}})` — 同时指定
- 不带 args 默认当天 + 交互选择 LLM

**流程概览（5 阶段）**：

| 阶段 | Agent | 内容 |
|------|-------|------|
| 选择 LLM | 通用 agent | 交互选择本次使用的 LLM 提供商（deepseek/volcengine） |
| 数据采集 | 通用 agent | 运行 `node scripts/fetch.js`，返回日期 |
| 深度分析 | 通用 agent | 运行 `node scripts/analyze.js --force --provider <name>` |
| 数据验证 | haiku agent | 检查配速趋势方向、周跑量周期、数据一致性，输出结构化报告 |
| 报告生成 | 通用 agent | 运行 `node scripts/report.js` + `open` |

验证 agent 会检查：
- 配速趋势标签（负分段加速/后程掉速）与实际首末公里配速方向是否一致
- 周跑量统计是否在周一→周日周期内
- bodyAssessment 中的 HRV/恢复/睡眠数值与原始数据是否一致

**注意**：调用 workflow 时需在 prompt 中包含 `ultrawork` 关键词（系统要求）。

### 手动分步执行（备用）

当 Workflow 不适用时（如 LLM 出问题、需精细控制参数），可手动分步执行：

1. `node scripts/fetch.js` — 采集最新数据 + 下载 TCX + TCX 解析（增量/全量自动判断）
2. `node scripts/analyze.js` — LLM 深度复盘 + 训练计划生成，输出 `YYYYMMDD-analysis.json`
3. `node scripts/report.js` — 生成 HTML 可视化报告，然后用 `open` 打开

脚本支持 `--date YYYYMMDD` 参数指定日期。fetch.js 支持 `--full` 强制全量刷新，analyze.js 支持 `--force` 强制重新分析、`--provider <name>` 指定 LLM 提供商。

**LLM 配置**：在 `coros.config.json` 中设置 `llm` 节，支持 `anthropic`、`openai`、`qianfan`、`deepseek`、`volcengine` 五个 provider。`llm.providers` 映射存储命名提供商配置，`--provider <name>` 从中查找。支持 `apiKey` 直接写死或 `apiKeyEnv` 环境变量。主 LLM 限流时自动切换到 `fallback` 配置的备用模型。

## 数据存储

- `data/daily/YYYYMMDD.json` — 每日概览（活动摘要 + 健康数据 + TCX 高级指标）
- `data/daily/YYYYMMDD-analysis.json` — LLM 分析结果（复盘 + 训练计划）
- `data/tcx/{labelId}.tcx` — TCX 运动文件（GPS 轨迹 + 逐点心率）
- `data/.crs-token/` — crs-connect 认证令牌（自动管理）
- `coros.config.json` — crs-connect 凭据 + LLM 配置（不提交到 git）


## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.