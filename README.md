# COROS Data Analyst

基于高驰 (COROS) MCP 数据接口的训练数据自动获取、深度复盘与训练计划系统。

面向备战首马的跑者，结合个人体能指标、恢复状态和训练目标，每日自动生成训练复盘报告和下一阶段训练计划。

## 功能

- **数据自动采集** — 调用 coros-mcp CLI 获取 10 类训练/健康数据，缓存为结构化 JSON
- **单次训练复盘** — 配速/心率/步频/训练负荷分析，与阈值配速对比，判定强度区间
- **恢复状态评估** — 综合HRV趋势、睡眠质量、静息心率，给出绿/黄/红三级恢复评分
- **周期训练概览** — 周跑量、训练负荷比、强度分布统计
- **智能训练计划** — 内置 24 周首马 330 训练框架，根据恢复状态动态调整强度
- **HTML 可视化报告** — Chart.js 图表展示 HRV/负荷/配速趋势

## 项目结构

```
├── scripts/
│   ├── fetch.js           # 数据采集：调 coros-mcp 获取 10 类数据
│   ├── analyze.js         # 分析引擎：复盘 + 恢复评估 + 周概览 + 训练计划
│   ├── report.js          # HTML 报告生成（Chart.js 图表）
│   ├── cron.sh            # 定时任务入口脚本
│   └── com.coros.daily-review.plist  # macOS launchd 配置
├── data/
│   ├── daily/             # 每日数据缓存 (YYYYMMDD.json)
│   ├── activities/        # 历史活动详情
│   └── *.json             # 历史批量数据
├── reports/               # 生成的 HTML 报告
├── .mcp.json              # Coros MCP 服务器配置
└── package.json
```

## 快速开始

### 前置条件

- Node.js >= 18（ESM 模块）
- [coros-mcp](https://www.npmjs.com/package/coros-mcp) CLI 已安装并登录

```bash
# 确认 coros-mcp 可用
coros-mcp --issuer https://mcpus.coros.com list-tools
```

### 运行

```bash
# 一键执行：采集 + 分析
bash scripts/cron.sh

# 或分步执行
node scripts/fetch.js          # 采集数据 → data/daily/YYYYMMDD.json
node scripts/analyze.js        # 生成 Markdown 分析报告
node scripts/report.js         # 生成 HTML 可视化报告

# 指定日期
node scripts/fetch.js --date 20260520
node scripts/analyze.js --date 20260520
```

### 定时自动执行

每日早上 7:00 自动采集数据并生成报告：

```bash
cp scripts/com.coros.daily-review.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.coros.daily-review.plist
```

日志输出至 `reports/cron.log`。

## 采集的数据

| 数据 | Coros MCP 工具 | 说明 |
|------|---------------|------|
| 用户档案 | `queryUserInfo` | 身高/体重/年龄 |
| 训练记录 | `querySportRecords` | 近 7 天跑步记录 |
| 活动详情 | `getActivityDetail` | 配速/心率/步频/负荷 |
| 每日健康 | `queryDailyHealthData` | 步数/热量/压力/睡眠 |
| 睡眠数据 | `querySleepData` | 深睡/浅睡/REM 比例 |
| HRV | `queryHrvAssessment` | 心率变异性评估 |
| 训练负荷 | `queryTrainingLoadAssessment` | 短期/长期负荷比 |
| 恢复状态 | `queryRecoveryStatus` | 恢复百分比/等级 |
| 体能评估 | `queryFitnessAssessmentOverview` | VO2max/阈值配速/预测成绩 |
| 训练日程 | `queryTrainingSchedule` | 本周 Coros 计划 |

## 分析模块

### 恢复评估

综合 HRV 连续偏低天数、恢复百分比、深睡比例，给出三级评估：

| 等级 | 条件 | 建议 |
|------|------|------|
| 🟢 良好 | HRV正常、恢复>85% | 按计划训练 |
| 🟡 注意 | HRV连续2天偏低 或 恢复<85% | 降低训练强度 |
| 🔴 警告 | HRV连续3天+偏低 或 恢复<70% | 安排休息日 |

### 训练计划框架

内置 24 周首马 330 备战计划，根据距比赛周数自动匹配阶段：

| 阶段 | 周数 | 周跑量 | 重点 |
|------|------|--------|------|
| 准备期 | 赛前29周+ | 45-60km | 建立基础跑量 |
| 基础期 I | W1-8 | 50-65km | 有氧耐力 |
| 基础期 II | W9-16 | 65-80km | 节奏跑引入 |
| 强化期 | W17-20 | 75-90km | 间歇/阈值/MP |
| 巅峰期 | W21-22 | 80-85km | 最长LSD |
| 减量期 | W23-24 | 50→30km | 减量保状态 |

训练计划根据恢复状态动态调整：恢复红 → 强度×0.6，恢复黄 → 强度×0.8。

### 330 马拉松关键参数

- 目标配速：4:58/km
- 阈值配速目标：4:20-4:25/km（当前 4:37）
- Yasso 800 参考：3:30/800m
- 周跑量峰值：80-90km

## 在 Claude Code 中使用

在 CLAUDE.md 中已配置训练复盘指令。在 Claude Code 对话中说"复盘"、"训练分析"、"训练计划"即可自动触发：

1. 采集最新数据
2. 生成分析报告
3. 输出复盘与计划

也可以直接运行脚本：

```bash
node scripts/fetch.js && node scripts/analyze.js
```

## 配置

`.mcp.json` 中配置了 Coros MCP 服务器（US 区域）：

```json
{
  "mcpServers": {
    "coros": {
      "command": "coros-mcp",
      "args": ["--issuer", "https://mcpus.coros.com"]
    }
  }
}
```

如使用中国区账号，将 issuer 改为 `https://mcpcn.coros.com`。
