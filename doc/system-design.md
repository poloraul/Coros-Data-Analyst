# 系统设计文档

## 1. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│                    macOS launchd (cron)                    │
│                   每日 07:00 触发                           │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                    cron.sh                                 │
│              fetch → analyze → report                      │
└──────┬──────────────────────┬────────────────┬───────────┘
       │                      │                │
       ▼                      ▼                ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
│   fetch.js       │  │ analyze.js   │  │   report.js      │
│                  │  │              │  │                  │
│ Coros MCP        │  │ LLM 复盘     │  │ HTML 生成        │
│ 10 项数据采集    │  │ 训练计划生成  │  │ Chart.js 图表    │
│ + TCX 下载+解析  │  │ 分析去重     │  │ 亮/暗主题        │
│ + 增量/全量      │  │ LLM fallback │  │                  │
└──┬────────┬──────┘  └──────┬───────┘  └────────┬─────────┘
   │        │                │                    │
   │   ┌────┴─────┐         ▼                    ▼
   │   │download  │  ┌──────────────┐    ┌──────────────────┐
   │   │-tcx.js   │  │ daily/       │    │ reports/         │
   │   │(子进程)  │  │ YYYYMMDD     │    │ YYYYMMDD-report  │
   │   └────┬─────┘  │ -analysis    │    │ .html            │
   │        │        │ .json        │    └──────────────────┘
   │        ▼        └──────────────┘
   │  ┌──────────┐         ▲
   │  │data/tcx/ │         │ 读取 daily JSON
   │  │*.tcx     │         │ (含 tcxMetrics)
   │  └──────────┘         │
   │                       │
   ▼                       │
┌──────────────────┐       │
│ daily/           │───────┘
│ YYYYMMDD.json    │
│ (含 tcxMetrics)  │
└──────────────────┘
```

## 2. 数据流

### 2.1 采集阶段（fetch.js）

```
Coros MCP Server ──callTool()──> 文本输出 ──parse*()──> 结构化 JSON
                                                          │
                                                          ▼
                                              download-tcx.js ──> TCX 文件
                                                          │
                                                          ▼
                                                  tcx-analyzer.js ──> tcxMetrics
                                                          │
                                                          ▼
                                              activityDetails[].tcxMetrics 写入 daily JSON
```

每个 MCP Tool 返回格式化的文本，由对应的 `parse*` 函数提取为 JSON 对象。10 项数据汇聚到一个 daily JSON 文件中。

**TCX 获取与解析**：fetch.js 在 MCP 数据采集后，自动调用 `download-tcx.js`（子进程）下载 TCX 文件，然后通过 `tcx-analyzer.js` 解析 TCX 数据，将 `tcxMetrics` 直接写入 daily JSON 的 `activityDetails` 中。analyze.js 无需再处理 TCX 解析。

**增量策略**：同一天内首次运行执行全量拉取（10 个 MCP 调用 + TCX 下载解析），后续运行仅刷新 sportRecords + activityDetails（2 个 MCP 调用），其余数据（userInfo、fitness、hrv、sleep、recovery、trainingLoad、schedule）从已有文件复用。按 labelId 去重合并。新增活动自动下载 TCX 并解析。`--full` 参数强制全量刷新。

### 2.2 下载阶段（download-tcx.js）

```
daily JSON ──> 提取 labelId+sportType ──> crs-connect API ──> TCX 文件
```

从 daily JSON 的 sportRecords 中提取活动标识，通过 `@nyt87/crs-connect` SDK 的 `getActivityDownloadFile` + `downloadFile` 下载 TCX。下载成功后回写 `tcxPath` 到 daily JSON。

**注意**：download-tcx.js 同时被 fetch.js 作为子进程调用，也可独立运行（手动下载/`--force` 重下载）。

### 2.3 分析阶段（analyze.js）

```
daily JSON（含 tcxMetrics）──> buildLLMContext() ──> 分析上下文 ──> LLM ──> analysis JSON
                                       │
                                       ├──> profile（用户档案）
                                       ├──> goal（训练目标）
                                       ├──> bodyStatus（恢复状态）
                                       ├──> workouts（训练详情 + tcxMetrics）
                                       └──> weeklySummary（周概览）
```

analyze.js 从 daily JSON 中直接读取已嵌入的 `tcxMetrics`，不执行 TCX 下载或解析。职责聚焦于：
- 构建 LLM 上下文
- 调用 LLM 生成深度复盘
- 生成训练计划
- 输出规则引擎 markdown（LLM 不可用时的降级方案）

TCX 高级指标包括：
- 公里分段、配速漂移、心率分区、步频分析、海拔分析
- 有氧脱钩、配速变异系数、跑步效率指数、心率恢复速率

**分析去重**：调用 LLM 前检查 `YYYYMMDD-analysis.json` 是否已存在，对比 workouts 日期列表。如果数据未变，跳过 LLM 调用直接使用已有结果。`--force` 参数强制重新分析。

### 2.4 报告阶段（report.js）

```
daily JSON ──> 内联分析逻辑 ──> HTML 模板 ──> reports/YYYYMMDD-report.html
```

报告生成逻辑独立于 analyze.js，内联实现了恢复评估、训练复盘、周计划生成。使用 Chart.js 渲染 HRV/负荷/配速图表。

## 3. 模块职责

### 3.1 脚本层（scripts/）

| 文件 | 职责 | 输入 | 输出 |
|------|------|------|------|
| fetch.js | 数据采集 + TCX 下载/解析（增量/全量） | --date, --full | data/daily/YYYYMMDD.json（含 tcxMetrics） |
| download-tcx.js | TCX 文件下载（独立运行或被 fetch.js 调用） | --date, --all, --force, --labelId | data/tcx/*.tcx |
| tcx-analyzer.js | TCX 解析与指标计算 | TCX 文件路径, maxHR | kmSplits/hrDrift/hrZones/paceCV/cadence/elevation |
| analyze.js | LLM 深度复盘 + 训练计划（去重） | --date, --mode, --force | data/daily/YYYYMMDD-analysis.json |
| report.js | HTML 报告生成 | --date | reports/YYYYMMDD-report.html |
| cron.sh | 自动化调度入口 | --weekly | 调用上述脚本 |
| com.coros.daily-review.plist | launchd 定时任务配置 | - | 每日 07:00 执行 |

### 3.2 库层（lib/）

| 文件 | 职责 | 导出 |
|------|------|------|
| tcx-utils.js | TCX 解析与基础指标计算 | parseTcxLaps, getTcxSummary, computeLapSplits, analyzePaceDrift, analyzeCadence, analyzeElevation, computePerKmHrTrend, calculateHrZones, getTcxEnrichedAnalysis |
| tcx-advanced.js | TCX 高级指标计算 | computeAerobicDecoupling, computePaceVariability, computeRunningEfficiencyIndex, computeHrRecoveryRate |
| context-builder.js | 分析上下文构建 | buildAnalysisContext |
| llm.js | LLM 调用封装 | createLLM（支持 anthropic/openai/qianfan + fallback 自动切换） |

## 4. 数据模型

### 4.1 Daily JSON 结构

```
{
  fetchDate: "YYYYMMDD",
  fetchedAt: "ISO datetime",
  userInfo: { height, weight, birthday, gender, nickname },
  sportRecords: [{ index, sport, date, duration, distance, avgPace, avgHR, calories, labelId, sportType, startCoords }],
  activityDetails: [{ labelId, sportType, date, distance, workoutTime, avgPace, movingAvgPace, adjustedPace, bestKm, avgHR, avgCadence, avgStrideLength, elevationGain, elevationLoss, calories, trainingLoad, performance, tcxPath?, tcxMetrics? }],
  dailyHealth: [{ date, steps, calories, exerciseMin, avgStress, sleepScore, sleepTotal, deepSleep, lightSleep, remSleep, awakeTime }],
  sleep: [{ date, sleepScore, mainSleep, deepRatio, lightRatio, remRatio, awakeRatio, awakeTimeMin, sleepWindow }],
  hrv: { baseline, normalRange: [low, high], days: [{ date, hrv, evaluation }] },
  trainingLoad: [{ date, comment, shortTermLoad, longTermLoad, loadRatio }],
  recovery: { percentage, level, estimatedFullRecovery },
  fitness: { vo2max, runningLevel, thresholdPace, pred5k, pred10k, predHalfMarathon, predMarathon },
  trainingSchedule: [{ date, type, distance, estimatedTime, load }]
}
```

### 4.2 Analysis JSON 结构

```
{
  fetchDate: "YYYYMMDD",
  generatedAt: "ISO datetime",
  context: {
    profile: { age, height, weight, gender, birthday, vo2max, thresholdPace, maxHR, racePredictions },
    goal: { targetTime, targetPace, marathonDate, weeksLeft, currentPhase, currentWeek, phaseFocus, targetWeeklyKm },
    bodyStatus: { recovery, hrv, sleep, stress, trainingLoad },
    workouts: [{ ...activityDetail, splits?, paceDrift?, hrZones?, cadenceStats?, elevationStats?, perKmHrTrend?, aerobicDecoupling?, paceVariability?, runningEfficiency?, hrRecoveryRate? }],
    weeklySummary: { totalKm, runCount, totalTL, intensityDistribution, loadRatio, shortTermLoad, longTermLoad }
  },
  analysis: "LLM 生成的复盘文本",
  plan: "LLM 生成的训练计划文本"
}
```

### 4.3 TCX 解析模型

```
Lap: { totalTimeSeconds, distanceMeters, avgHR, maxHR, calories, intensity, triggerMethod, trackpoints[] }
Trackpoint: { hr, distanceMeters, time, cadence, altitudeMeters, speed, lat, lon }
```

## 5. 外部依赖

| 依赖 | 用途 | 版本 |
|------|------|------|
| @anthropic-ai/sdk | Anthropic Claude API 调用 | ^0.97.1 |
| openai | OpenAI / Qianfan API 调用（兼容接口） | ^6.38.0 |
| @nyt87/crs-connect | 高驰 API 登录与文件下载 | - |
| coros-mcp | 高驰 MCP Server CLI | - |
| Chart.js | HTML 报告图表渲染（CDN） | 4.4.7 |

## 6. 配置管理

### coros.config.json（不提交 git）

```json
{
  "email": "xxx",
  "password": "xxx",
  "llm": {
    "provider": "anthropic|openai|qianfan",
    "model": "...",
    "apiKeyEnv": "ANTHROPIC_API_KEY|OPENAI_API_KEY|QIANFAN_API_KEY",
    "apiKey": "（可选，直接写死 key，优先于 apiKeyEnv）",
    "maxTokens": 4096,
    "fallback": {
      "provider": "qianfan",
      "model": "deepseek-v4-pro",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "sk-xxx"
    }
  }
}
```

主 LLM 限流（429/rate/limit/配额）时自动切换到 `fallback` 配置的备用模型。`apiKey` 字段优先于 `apiKeyEnv` 环境变量。

### 环境变量

| 变量 | 用途 |
|------|------|
| ANTHROPIC_API_KEY | Anthropic LLM 认证 |
| OPENAI_API_KEY | OpenAI LLM 认证 |
| QIANFAN_API_KEY | 百度千帆 LLM 认证 |
| COROS_EMAIL | 高驰账号（优先于 config 文件） |
| COROS_PASSWORD | 高驰密码（优先于 config 文件） |
