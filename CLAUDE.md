# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Coros Data Analyst — 基于高驰 MCP 数据的训练自动复盘与计划系统。

用户目标：2026年12月初首马，目标 3:30 以内。

## Environment

- MCP: Puppeteer server is enabled for browser automation tasks
- MCP: Coros server is enabled for training data access

## 训练复盘指令

当用户要求复盘、训练分析、训练计划、恢复评估时，按以下步骤执行：

1. `node scripts/fetch.js` — 采集最新数据
2. `node scripts/download-tcx.js` — 下载 TCX 运动文件（高级分析用）
3. `node scripts/analyze.js` — TCX 高级分析 + LLM 深度复盘，生成 `YYYYMMDD-analysis.json`
4. `node scripts/report.js` — 生成 HTML 可视化报告，然后用 `open` 打开

脚本支持 `--date YYYYMMDD` 参数指定日期。

**LLM 配置**：在 `coros.config.json` 中设置 `llm` 节，支持 `anthropic` 和 `openai` 两个 provider。需要设置对应的环境变量（`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`）。

## 数据存储

- `data/daily/YYYYMMDD.json` — 每日概览（活动摘要 + 健康数据）
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