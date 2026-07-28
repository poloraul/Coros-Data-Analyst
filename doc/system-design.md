# 系统设计文档

## 1. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│               trigger: macOS launchd / Claude Workflow    │
│                   每日 07:00 / 手动触发                     │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                 daily-review workflow                      │
│    选择 LLM → 数据采集 → 深度分析 → 数据验证 → 计划推送 → 报告生成      │
└──────┬──────────────────────┬────────────────┬───────────┘
       │                      │                │
       ▼                      ▼                ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
│   fetch.js       │  │ analyze.js   │  │  push-plan.py   │
│                  │  │              │  │                  │
│ Coros MCP        │  │ LLM 复盘     │  │ coros-training-  │
│ 10 项数据采集    │  │ 训练计划生成  │  │ mcp (Python)     │
│ + TCX 下载+解析  │  │ 分析去重     │  │ create_run_work- │
│ + 增量/全量      │  │ LLM fallback │  │ out + schedule   │
│ + TCX 数据修复   │  │ Token 优化   │  │ → COROS 日历     │
└──┬────────┬──────┘  └──────┬───────┘  └──────────────────┘
   │        │                │                    │
   │   ┌────┴─────┐         ▼                    ┌──────────────────┐
   │   │download  │  ┌──────────────┐    ┌───────┤  reports/        │
   │   │-tcx.js   │  │ daily/       │    │       │  YYYYMMDD-report │
   │   │(子进程)  │  │ YYYYMMDD     │    │       │  .html           │
   │   └────┬─────┘  │ -analysis    │    │       │  chart.min.js    │
   │        │        │ .json        │    │       └──────────────────┘
   │        ▼        └──────┬───────┘    │              ▲
   │  ┌──────────┐          │            │  report.js   │
   │  │data/tcx/ │          │ 分析 JSON  │              │
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
                                                          │
                                                          ▼
                                              reconcileFromTCX() ──> 修复缺失 activityDetails
```

每个 MCP Tool 返回格式化的文本，由对应的 `parse*` 函数提取为 JSON 对象。10 项数据汇聚到一个 daily JSON 文件中。

**TCX 获取与解析**：fetch.js 在 MCP 数据采集后，自动调用 `download-tcx.js`（子进程）下载 TCX 文件，然后通过 `tcx-analyzer.js` 解析 TCX 数据，将 `tcxMetrics` 直接写入 daily JSON 的 `activityDetails` 中。analyze.js 无需再处理 TCX 解析。

**数据完整性修复**：`reconcileFromTCX()` 遍历 sportRecords，对有 TCX 文件但无 activityDetail 的记录，通过 TCX 解析自动补全 activityDetails（含 tcxMetrics）。这解决了部分活动因事后同步到 COROS API 导致 getActivityDetail 调用失败的问题。

**增量策略**：同一天内首次运行执行全量拉取（10 个 MCP 调用 + FIT 下载解析），后续运行仅刷新 sportRecords + activityDetails（2 个 MCP 调用），其余数据（userInfo、fitness、hrv、sleep、recovery、trainingLoad、schedule）从已有文件复用。按 labelId 去重合并。新增活动自动下载 FIT 并解析。`--full` 参数强制全量刷新。

### 2.2 下载阶段（download-tcx.js → download-fit.js）

```
daily JSON ──> 提取 labelId+sportType ──> MCP queryActivityFitFileDownloadUrls ──> FIT 文件
```

从 daily JSON 的 sportRecords 中提取活动标识，通过 npm `coros-mcp` 的 MCP 工具 `queryActivityFitFileDownloadUrls` 获取下载 URL，下载 FIT 格式文件到 `data/fit/{labelId}.fit`。然后通过 `fit-analyzer.js` 解析为结构化指标，存入 `activityDetails[].tcxMetrics` 字段。

**FIT 提取的完整指标集**（2026-07-28 新增补充字段）：
- `kmSplits[]` — 每公里分段（配速、心率、步频）
- `hrDrift` — 心率漂移（前1/3 vs 后1/3 平均心率对比）
- `hrZones` — 心率区间 Z1-Z5 时间分布（基于 maxHR）
- `paceCV` — 配速变异系数（含 CV% + 评估等级）
- **`paceDrift`** — 中点配速漂移（前半程 vs 后半程平均配速对比）
- `cadence` — 步频分析（均值、标准差、<170、**170-180**、>180 三段百分比）
- `elevation` — 海拔分析（累计上升/下降、**净海拔、平均海拔**、最高/最低）
- **`lapSummaries[]`** — 每圈摘要（距离/时间/配速/平均HR/最大HR/步频/功率/触发方式）
- **`maxHR`** — FIT Session 记录的最大心率
- **`gpsTrackpoints[]`** — 逐点 GPS 坐标（纬度/经度/距离/海拔）
- **`avgTemp`** — 腕表平均温度（若手表支持）

**注意**：download-tcx.js 同时被 fetch.js 作为子进程调用，也可独立运行（`--check` 预览/`--force` 重下载）。

### 2.3 分析阶段（analyze.js）

```
daily JSON（含 tcxMetrics）──> buildLLMContext() ──> 分析上下文（~4KB）──> LLM ──> analysis JSON
                                       │
                                       ├──> profile（年龄/身高/体重/VO2max/阈值配速/HRmax）
                                       ├──> goal（训练目标/阶段/周数）
                                       ├──> bodyStatus（恢复/HRV/睡眠/训练负荷）
                                       ├──> paceZones（压缩格式：仅 key/name/range）
                                       ├──> hrZones（压缩格式：仅 key/name/range）
                                       ├──> workouts（训练详情 + tcxSummary 压缩摘要 + kmSplitSummary 逐公里配速/心率）
                                       ├──> today / weeklySummary
                                       └──> holidays（thisWeek + upcomingNext4Weeks）
```

analyze.js 从 daily JSON 中直接读取 `tcxMetrics`，通过 `summarizeTcxMetrics()` 压缩为一行文本摘要（配速趋势/心率漂移/区间分布/步频），替代原始数组发送给 LLM。职责聚焦于：
- 构建 LLM 上下文（含 TCX 摘要压缩 + zone 压缩 + 节假日信息）
- 调用 LLM 生成深度复盘与训练计划
- 输出规则引擎 markdown（LLM 不可用时的降级方案）

**Token 优化措施**（2026-06-15 更新 / 2026-06-18 补充）：
- `tcxSummary` 替代 `tcxMetrics`：原始 kmSplits 数组 → 一行文本摘要（~400 字符）
- `kmSplitSummary`（2026-06-18 新增）：压缩逐公里配速+心率数据传递 LLM（`KM1=6:14(HR113) KM2=5:55(HR121)...`），支持训练阶段识别和模式分类
- `compressZones()`：paceZones/hrZones 移除 color/short/pctOfThreshold 等 UI 字段
- 移除过期 `upcomingRace` 硬编码
- `holidays.upcoming` 从全量 13 条裁剪至未来 4 周
- 上下文从 ~5KB 压缩至 ~4KB（-20%），新增 kmSplitSummary 后约 5-5.5KB

**训练哲学**（已写入 system prompt）：
- 二区训练（Z2 有氧耐力区）：配速约 5:04-6:03/km，心率约 136-153bpm，是有氧基础的核心
- 两极化训练（Polarized Training）：~80%低强度（Z1-Z2）+ ~20%高强度（Z4-Z6），最小化 Z3（灰色区）
- 高质量课（Z4+）放在周三或周四
- LSD（Z2为主）安排在周六或周日
- 轻松跑（Z2纯有氧）安排在其他训练日
- 节假日当天可安排强度课

**增量分析**（2026-06-18 更新）：仅分析新增活动的 workoutReviews，合并保留历史分析的全局字段（bodyAssessment/trainingPatternAnalysis/weeklyPlan）。`--force` 参数强制全量重新分析。

### 2.4 验证阶段（validate.js）

```
analysis JSON ──> validate.js ──> { issues[], hasIssues, summary }
```

纯 Node.js 脚本，无 LLM 依赖。检查项：
- TCX 配速趋势标签与实际方向一致性
- weeklyPlan 首日与报告日期对齐

### 2.5 推送阶段（push-plan.py）

```
analysis JSON ──> 读取 weeklyPlan
    │
    ├── 有 workoutSteps? ──> 直接转换为 COROS steps（与详细计划一致）
    └── 无 workoutSteps? ──> 规则引擎转换（传统回退）
                              │
                              └──> coros_api (Python)
                                    ├──> build_run_workout_payload() ──> COROS 训练库
                                    └──> schedule_workout() ──> COROS 手表日历
```

push-plan.py 直接导入 `coros_api` 模块（`coros-training-mcp` 包的底层库），绕过 MCP stdio 通信层，调用：
- `build_run_workout_payload(name, steps)` + `create_workout_from_raw(auth, payload)` — 构建并创建训练计划
- `schedule_workout(auth, workout_id, happen_day)` — 推送到指定日期

**workoutSteps 优先路径**（推荐）：LLM 在 `weeklyPlan[].workoutSteps` 中输出结构化步骤数组，每步格式为 `{"kind":"warmup/training/cooldown","targetDistanceKm":数字,"pace":"X:XX-X:XX/km"}` 或间歇组 `{"repeat":组数,"steps":[...]}`。`push-plan.py` 直接使用这些值，确保推送计划与报告中的详细计划完全一致。

**规则引擎回退**：当 `workoutSteps` 不存在时（历史分析文件），按训练类型（轻松跑/节奏跑/间歇/LSD）用固定比例（15%/12% 热身/冷身）分配距离，配速从 `context.paceZones` 中按区间查找。

**配速值格式**：COROS 使用**秒/公里**（非毫秒/公里，尽管 `pace_parser.py` 文档写的是 ms）。例如 6:20/km → `intensity_value=380`（秒），`intensity_display_unit=0`（系统默认，显示 min/km）。

**安全机制**：`--confirm` 标志区分预览/实际推送；推送前自动查询目标日期已有排程并删除（避免重复）；推送日志记录到 `data/push-logs/`。

### 2.6 报告阶段（report.js）

```
daily JSON ──> 内联分析逻辑 ──> HTML 模板 ──> reports/YYYYMMDD-report.html
analysis JSON ──> AI 分析数据 ──> 配速区间自动推导 ──> 训练计划表格
```

报告生成独立于 analyze.js，从共用模块导入 `assessRecovery` 和 `PHASE_TEMPLATES`。使用 Chart.js 本地渲染图表。

**数据一致性保障**：
- `derivePaceZone()`：从详细计划的配速文字中提取实际配速范围，自动推导配速区间（覆盖 LLM 独立生成的 paceZone）
- `extractPaceRange()`：过滤跨步跑配速，避免干扰主训练区间判断
- 进度条和训练一览表使用近7天滑动窗口

## 3. 模块职责

### 3.1 脚本层（scripts/）

| 文件 | 职责 | 输入 | 输出 |
|------|------|------|------|
| fetch.js | 数据采集 + FIT 下载/解析 + 数据修复（增量/全量） | --date, --full | data/daily/YYYYMMDD.json（含 tcxMetrics） |
| download-tcx.js | FIT 文件下载（独立运行或被 fetch.js 调用） | --date, --all, --force, --labelId | data/fit/*.fit |
| fit-analyzer.js | FIT 二进制解析与高级指标计算 | FIT 文件路径, maxHR | kmSplits/hrDrift/hrZones/paceCV/paceDrift/cadence/elevation/lapSummaries/maxHR/gpsTrackpoints/avgTemp |
| analyze.js | LLM 深度复盘 + 训练计划（去重，Token 优化） | --date, --force, --provider | data/daily/YYYYMMDD-analysis.json |
| validate.js | 数据一致性检查（无 LLM） | --date | JSON: { issues[], hasIssues, summary } |
| **push-plan.py** | **AI 训练计划推送到 COROS 手表日历（直接调用 coros_api）** | **--date, --confirm** | **data/push-logs/*.json** |
| report.js | HTML 报告生成（配速区间推导，本地 Chart.js） | --date | reports/YYYYMMDD-report.html |
| cron.sh | 自动化调度入口 | --weekly | 调用上述脚本 |
| com.coros.daily-review.plist | launchd 定时任务配置 | - | 每日 07:00 执行 |

### 3.2 库层（lib/）

| 文件 | 职责 | 导出 |
|------|------|------|
| zones.js | 配速区间 & 心率区间计算（COROS 6 区标准） | calcPaceZones, calcHRZones, classifyPace, classifyHR, ZONE_LABELS |
| training-constants.js | 训练常量定义 | MARATHON_DATE, MARATHON_TARGET_TIME, MARATHON_TARGET_PACE, PHASES, LACTATE_THRESHOLD_HR |
| training-utils.js | 训练工具函数 | paceToSeconds, secondsToPace, getAge, weeksUntilMarathon, getCurrentPhase, getCurrentWeekBounds |
| training-templates.js | 6 阶段×7 天训练计划模板 | PHASE_TEMPLATES |
| recovery.js | 恢复状态评估（共用） | assessRecovery |
| holidays.js | 2026 年中国法定节假日数据 | getHolidayAnnotations, getHolidaysInRange, isHoliday |
| weather.js | 天气数据获取（Open-Meteo API） | fetchWeather |
| llm.js | LLM 调用封装 | createLLM（支持 anthropic/openai/qianfan/deepseek + fallback 自动切换） |
| tcx-utils.js | TCX 解析与基础指标计算 | parseTcxLaps, computeLapSplits, analyzePaceDrift, analyzeCadence, analyzeElevation |

## 4. 数据模型

### 4.1 Daily JSON 结构

```
{
  fetchDate: "YYYYMMDD",
  fetchedAt: "ISO datetime",
  userInfo: { height, weight, birthday, gender, nickname },
  sportRecords: [{ index, sport, date, duration, distance, avgPace, avgHR, calories, labelId, sportType, startCoords }],
  activityDetails: [{ labelId, sportType, date, distance, workoutTime, avgPace, movingAvgPace, adjustedPace, bestKm, avgHR, avgCadence, avgStrideLength, elevationGain, elevationLoss, calories, trainingLoad, performance, avgPower?, tcxPath?, tcxMetrics?, weather? }],
  dailyHealth: [{ date, steps, calories, exerciseMin, avgStress, sleepScore, sleepTotal, deepSleep, lightSleep, remSleep, awakeTime }],
  sleep: [{ date, sleepScore, mainSleep, deepRatio, lightRatio, remRatio, awakeRatio, awakeTimeMin, sleepWindow }],
  hrv: { baseline, normalRange: [low, high], days: [{ date, hrv, evaluation }] },
  trainingLoad: [{ date, comment, shortTermLoad, longTermLoad, loadRatio }],
  recovery: { percentage, level, estimatedFullRecovery },
  fitness: { vo2max, runningLevel, thresholdPace, pred5k, pred10k, predHalfMarathon, predMarathon },
  trainingSchedule: [{ date, type, distance, estimatedTime, load }]
}
```

**注意**：activityDetails 可能通过 `reconcileFromTCX()` 从 TCX 文件补全，此时部分字段（trainingLoad、performance、bestKm）为 null。

### 4.2 Analysis JSON 结构

```
{
  fetchDate: "YYYYMMDD",
  generatedAt: "ISO datetime",
  context: {
    profile: { age, height, weight, vo2max, thresholdPace, maxHR },
    goal: { targetTime, targetPace, marathonDate, weeksLeft, currentPhase, currentWeek, phaseFocus, targetWeeklyKm },
    bodyStatus: {
      recovery: { percentage, level },
      hrv: { baseline, normalRange, latestValue, latestEval, consecutiveBelow },
      sleep: { latestScore, deepRatio },
      trainingLoad: { shortTerm, longTerm, ratio, comment }
    },
    paceZones: [{ key, name, range }],     // 压缩格式（6 区）
    hrZones: [{ key, name, range }],        // 压缩格式（6 区）
    workouts: [{ date, distance, duration, avgPace, bestKm, avgHR, avgCadence, trainingLoad, performance, tcxSummary, kmSplitSummary }],
    today: { date, dayOfWeek },
    weeklySummary: { totalKm, runCount, totalTL },
    holidays: { thisWeek, upcomingNext4Weeks: [{ date, name }] }
  },
  analysis: {
    workoutReviews: [{ date, trainingType, phaseBreakdown: { warmup, main, cooldown, structureQuality }, summary, detailedAnalysis, positives[], improvements[] }],
    bodyAssessment: { overallLevel, summary, details[], recommendations[] },
    trainingPatternAnalysis: { summary, strengths[], risks[], suggestions[] },
    weeklyPlan: [{ dayIndex, dayName, date, type, totalDistance, paceZone, hrZone, description, 详细计划: { warmup, main, cooldown, notes } }],
    coachAdvice: "..."
  }
}
```

**注意**：
- `paceZones` 和 `hrZones` 已压缩（移除 color/short/pctOfThreshold/hrRangeShort），仅保留 key/name/range
- `holidays.upcomingNext4Weeks` 仅包含未来 4 周的节假日（而非全量至年底）
- 已移除 `upcomingRace`（过期硬编码字段）
- `workouts[].tcxSummary` 为压缩文本摘要（格式：`配速漂移4:55→5:00(+1.7%); HRmax169; 3圈(HR峰值3圈); HR120→129漂移7.5%; Z:Z1-2 53% Z3-4 47% Z5 0% (主Z2); 步频170(170-180:47% >180:7%); 爬升+4m净+1m均8m; 腕温32.5°C`）
- `workouts[].kmSplitSummary`（2026-06-18 新增）为逐公里配速+心率压缩文本，用于 LLM 训练阶段识别（热身/主训练/冷身）和训练模式分类（轻松跑/阈值跑/间歇跑/LSD 等）
- `workoutReviews[].trainingType` 和 `workoutReviews[].phaseBreakdown`（2026-06-18 新增）为 LLM 分析新增的输出字段，`report.js` 可选渲染

### 4.3 TCX 解析模型

```
Lap: { totalTimeSeconds, distanceMeters, avgHR, maxHR, calories, intensity, triggerMethod, trackpoints[] }
Trackpoint: { hr, distanceMeters, time, cadence, altitudeMeters, speed, lat, lon }
```

## 5. 配速 & 心率区间系统

### 5.1 配速区间（COROS 6 区标准）

基于乳酸阈配速（当前 4:18/km），按百分比计算：

| 区间 | 名称 | 配速范围 | 占阈值 | 计算方式 |
|:----:|------|---------|:-----:|---------|
| Z1 | 积极恢复区 | > 6:03/km | <71% | tp / 0.71 |
| Z2 | 有氧耐力区 | 5:04 ~ 6:03/km | 71-85% | tp / 0.85 ~ tp / 0.71 |
| Z3 | 有氧动力区 | 4:37 ~ 5:04/km | 86-93% | tp / 0.93 ~ tp / 0.85 |
| Z4 | 乳酸阈区 | 4:13 ~ 4:37/km | 94-102% | tp / 1.02 ~ tp / 0.93 |
| Z5 | 速度耐力区 | 3:50 ~ 4:13/km | 103-112% | tp / 1.12 ~ tp / 1.02 |
| Z6 | 无氧动力区 | < 3:50/km | >112% | tp / 1.12 |

### 5.2 心率区间（COROS 6 区标准）

基于乳酸阈心率（当前 170 bpm），按百分比计算：

| 区间 | 名称 | 心率范围 | 占 LTHR | 计算方式 |
|:----:|------|---------|:-----:|---------|
| Z1 | 积极恢复区 | < 136 bpm | <80% | LTHR × 0.80 |
| Z2 | 有氧耐力区 | 136 ~ 153 bpm | 80-90% | LTHR × 0.90 |
| Z3 | 有氧动力区 | 153 ~ 163 bpm | 91-95% | LTHR × 0.96 |
| Z4 | 乳酸阈区 | 163 ~ 173 bpm | 96-102% | LTHR × 1.02 |
| Z5 | 速度耐力区 | 173 ~ 180 bpm | 103-106% | LTHR × 1.06 |
| Z6 | 无氧动力区 | > 180 bpm | >106% | LTHR × 1.06 |

### 5.3 功率区间（基于估算 FTP）

功率区间系统使用 `lib/power-utils.js` 中的 `calcPowerZones()`。FTP 通过 `estimateFTP()` 从最近 3 次有效户外跑（≥5km）的 avgPower 加权平均 × 0.90 估算。

| 区间 | 名称 | %FTP |
|------|------|------|
| Z1 | 积极恢复区 | <55% |
| Z2 | 有氧耐力区 | 55-75% |
| Z3 | 有氧动力区 | 75-90% |
| Z4 | 乳酸阈区 | 90-105% |
| Z5 | 速度耐力区 | 105-120% |
| Z6 | 无氧动力区 | >120% |

**数据源约束**：COROS `get_activity_detail` 仅返回单值 `Average Power`，**无逐秒功率**（`<Watts>` 标签在 TCX 文件中缺失）。因此不能计算 NP/VI/EF/W'bal 等高阶指标——所有功率功能仅基于 avgPower 单值。

**FTP 置信度**：`estimateFTP()` 返回 `confidence: "high"|"medium"|"low"|"none"`，LLM 在 confidence 为 "low" 或 "none" 时不给出功率区间建议。

## 6. 外部依赖

| 依赖 | 用途 | 版本 |
|------|------|------|
| @anthropic-ai/sdk | Anthropic Claude API 调用 | ^0.97.1 |
| openai | OpenAI / DeepSeek / Qianfan API 调用（兼容接口） | ^6.38.0 |
| chart.js | HTML 报告图表渲染（本地加载） | 4.4.7 |
| coros-mcp（npm） | COROS MCP 协议：数据采集 + FIT 下载 | `/opt/homebrew/bin/coros-mcp` |
| coros-training-mcp（Python） | COROS Training Hub API：训练计划创建与排程 | `~/.local/bin/coros-mcp`（uv tool install） |
| fit-file-parser | FIT 文件解析（Garmin 格式） | `npm install fit-file-parser` |
| coros-mcp | 高驰 MCP Server CLI（数据采集） | - |

## 7. 配置管理

### coros.config.json（不提交 git）

```json
{
  "email": "xxx",
  "password": "xxx",
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "apiKey": "sk-xxx",
    "maxTokens": 8192,
    "fallback": {
      "provider": "qianfan",
      "model": "deepseek-v4-pro",
      "baseURL": "https://qianfan.baidubce.com/v2/coding",
      "apiKey": "sk-xxx"
    },
    "providers": {
      "deepseek": { "provider": "deepseek", "model": "deepseek-v4-pro", "apiKey": "sk-xxx" }
    }
  }
}
```

fallback 配置为百度千帆的 DeepSeek 兼容接口。

### 环境变量

| 变量 | 用途 |
|------|------|
| ANTHROPIC_API_KEY | Anthropic LLM 认证 |
| OPENAI_API_KEY | OpenAI LLM 认证 |
| QIANFAN_API_KEY | 百度千帆 LLM 认证 |
| DEEPSEEK_API_KEY | DeepSeek LLM 认证 |
| COROS_EMAIL | 高驰账号（优先于 config 文件） |
| COROS_PASSWORD | 高驰密码（优先于 config 文件） |