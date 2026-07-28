# 产品需求文档 (PRD)

## 1. 产品概述

**产品名称**：Coros Data Analyst — 高驰训练自动复盘与计划系统

**一句话描述**：基于高驰手表数据，自动完成每日训练复盘、恢复评估与下周训练计划生成，辅助跑者科学备战首马。

**目标用户**：使用高驰手表的跑步爱好者，当前为单人使用（用户 Jarvis），备战 2026 年 12 月首马，目标 3:30 以内。

**核心价值**：将分散在手表 App 中的训练数据、健康指标、恢复状态整合为一份可操作的复盘报告 + 训练计划，降低手动分析成本，避免过度训练或训练不足。

---

## 2. 用户目标与约束

| 项目 | 内容 |
|------|------|
| 比赛目标 | 2026 年 12 月 6 日首马，完赛时间 < 3:30:00 |
| 目标配速 | 4:58/km |
| 当前水平 | VO2max 54, 阈值配速 4:18/km, 乳酸阈心率 170 bpm, 全马预测 3:18:18 |
| 差距 | 当前预测已在目标以内，训练重点转向夯实有氧基础 |
| 训练周期 | 25 周系统训练（当前处于准备期 W0） |
| 训练偏好 | 间歇跑/节奏跑放在周三或周四，LSD 放在周末，节假日可安排强度课 |

---

## 3. 核心功能需求

### F1. 数据采集（fetch.js）

**描述**：从高驰 MCP Server 采集多维训练与健康数据，存储为结构化 JSON。

**输入**：日期参数（默认当天）

**输出**：`data/daily/YYYYMMDD.json`

**采集数据项**：

| 序号 | 数据项 | MCP Tool | 采集范围 |
|------|--------|----------|----------|
| 1 | 用户信息 | queryUserInfo | - |
| 2 | 运动记录 | querySportRecords | 7 天 |
| 3 | 活动详情 | getActivityDetail | 逐条 |
| 4 | 每日健康 | queryDailyHealthData | 7 天 |
| 5 | 睡眠数据 | querySleepData | 3 天 |
| 6 | HRV 评估 | queryHrvAssessment | 7 天 |
| 7 | 训练负荷 | queryTrainingLoadAssessment | 7 天 |
| 8 | 恢复状态 | queryRecoveryStatus | - |
| 9 | 体能概览 | queryFitnessAssessmentOverview | - |
| 10 | 训练计划 | queryTrainingSchedule | 本周 |

**增量策略**：同一天内首次运行全量拉取，后续仅刷新 sportRecords + activityDetails，其余数据复用。支持 `--full` 强制全量刷新。

**数据完整性修复**：`reconcileFromFIT()` 自动比对 sportRecords 与 activityDetails，对有 FIT 文件但缺失 activityDetail 的记录，通过 FIT 解析补全数据。

**验收标准**：
- 单次运行采集全部 10 项数据，输出 JSON 可被下游脚本正确解析
- 支持 `--date` 参数指定日期
- 单项采集失败时输出 WARN 但不中断整体流程
- 缺失的 activityDetails 自动通过 FIT 补全

### F2. FIT 文件下载（download-tcx.js）

**描述**：通过 npm `coros-mcp` 的 MCP 工具 `queryActivityFitFileDownloadUrls` 获取 FIT 下载地址并下载，供高级分析使用。

**输入**：日期 / 全部 / 指定 labelId

**输出**：`data/fit/{labelId}.fit`

**验收标准**：
- 支持增量下载（已存在的 FIT 跳过）
- 支持 `--force` 强制重新下载
- MCP token 过期自动重试
- 解析后写入 `tcxMetrics`（与旧 TCX 保持相同字段名）

### F3. FIT 高级分析 + LLM 深度复盘（analyze.js）

**描述**：通过 `fit-analyzer.js` 解析 FIT 逐点数据，计算高级指标（与之前 `tcx-analyzer.js` 完全对齐），调用 LLM 生成深度复盘与训练计划。

**FIT 高级指标**：（保留在 daily JSON 中供报告图表使用，LLM 上下文中已压缩为 `tcxSummary` 文本摘要以降低 token 消耗）

| 指标 | 说明 |
|------|------|
| 公里分段 | 逐公里配速 + 心率 |
| 心率漂移 | HR 前后半程差值百分比 |
| 心率分区 | Z1-Z6 时间占比（COROS 6 区标准） |
| 配速变异系数 | CV 值反映匀速控制能力 |
| 步频分析 | 均值/标准差/>180spm 占比 |
| 海拔分析 | 累计爬升/下降 |

**LLM 上下文**（~4KB，持续优化中）：
- profile / goal / bodyStatus / workouts（含 tcxSummary）
- paceZones / hrZones（压缩格式，仅保留 key/name/range）
- today / weeklySummary / holidays（thisWeek + upcomingNext4Weeks）

**LLM 复盘输出**：`data/daily/YYYYMMDD-analysis.json`

**训练计划生成偏好**：
- 间歇跑/节奏跑等强度课放在周三或周四
- LSD 安排在周六或周日
- 节假日当天可安排强度课
- 其他日期安排轻松跑或休息

**验收标准**：
- TCX 指标计算结果合理（与 Coros App 数据对比偏差 < 5%）
- LLM 输出包含训练复盘、恢复评估、训练建议
- 支持 anthropic / openai / qianfan / deepseek 四个 provider
- LLM 不可用时降级为规则引擎生成 markdown

### F4. HTML 可视化报告（report.js）

**描述**：生成包含图表的 HTML 报告，支持亮/暗主题，Chart.js 本地加载。

**报告内容**：
- 关键指标卡片（近7天跑量、训练负荷、恢复状态、HRV、VO2max、全马预测）
- 配速区间 & 心率区间参考表（COROS 6 区标准）
- 最近训练深度复盘（配速/心率/步频分析 + 亮点/改进方向）
- 逐秒配速 & 心率图表（基于 TCX 数据）
- 其他近期训练（近7天）
- HRV 7 日趋势图、训练负荷趋势图、配速 vs 阈值图
- 睡眠质量趋势图
- 近期训练一览表（近7天）
- 恢复指标详情
- 身体状态评估 + 训练模式分析（AI 分析）
- 下一阶段训练计划（含详细配速区间自动推导）
- AI 教练建议

**数据一致性保障**：
- 配速区间自动从详细计划推导，确保与列表显示一致
- 跨步跑配速自动过滤，不干扰主训练区间判断
- 进度条使用近7天滑动窗口，不受自然周起始日限制

**验收标准**：
- HTML 可用浏览器直接打开，图表正常渲染
- 亮/暗主题切换正常
- 离线可用（Chart.js 本地化）
- 周日自动生成（cron 调度）

### F5. 数据验证（validate.js）

**描述**：分析完成后自动检查数据一致性，无需 LLM 参与。

**检查项**：
- TCX 配速趋势标签（负分段加速/后程掉速）与实际配速方向一致性
- bodyAssessment 中 HRV/恢复数值引用正确性
- weeklyPlan 首日日期与报告日期对齐

**验收标准**：
- 验证脚本 < 1 秒内完成
- 输出结构化 JSON（issues 数组 + hasIssues + summary）

### F6. 自动化调度

**描述**：通过 macOS launchd 或 Claude Code Workflow 实现每日自动采集 + 分析。

**触发方式**：
- macOS launchd：`com.coros.daily-review.plist`，每日 07:00 执行
- Claude Code Workflow：`daily-review`，一键执行 5 阶段流程

**验收标准**：
- launchd plist 加载后每日定时执行
- Workflow 一键执行采集→分析→验证→报告全流程

---

## 4. 训练计划框架

### 配速区间（COROS 6 区标准，基于阈值配速 4:18/km）

| 区间 | 名称 | 配速范围 | 占阈值 |
|:----:|------|---------|:-----:|
| Z1 | 积极恢复区 | > 6:03/km | <71% |
| Z2 | 有氧耐力区 | 5:04 ~ 6:03/km | 71-85% |
| Z3 | 有氧动力区 | 4:37 ~ 5:04/km | 86-93% |
| Z4 | 乳酸阈区 | 4:13 ~ 4:37/km | 94-102% |
| Z5 | 速度耐力区 | 3:50 ~ 4:13/km | 103-112% |
| Z6 | 无氧动力区 | < 3:50/km | >112% |

### 心率区间（COROS 6 区标准，基于乳酸阈心率 170 bpm）

| 区间 | 名称 | 心率范围 | 占 LTHR |
|:----:|------|---------|:-----:|
| Z1 | 积极恢复区 | < 136 bpm | <80% |
| Z2 | 有氧耐力区 | 136 ~ 153 bpm | 80-90% |
| Z3 | 有氧动力区 | 153 ~ 163 bpm | 91-95% |
| Z4 | 乳酸阈区 | 163 ~ 173 bpm | 96-102% |
| Z5 | 速度耐力区 | 173 ~ 180 bpm | 103-106% |
| Z6 | 无氧动力区 | > 180 bpm | >106% |

### 功率区间（基于估算 FTP）

功率区间用于辅助解读跑步训练中的机械功率输出。FTP 通过最近 3 次有效户外跑（≥5km）的 avgPower 加权平均 × 0.90 估算。

| 区间 | 名称 | %FTP | 训练用途 |
|:----:|------|:----:|---------|
| Z1 | 积极恢复区 | <55% | 跑后恢复、热身末段 |
| Z2 | 有氧耐力区 | 55-75% | 轻松跑、长距离 LSD |
| Z3 | 有氧动力区 | 75-90% | 马拉松配速、节奏跑 |
| Z4 | 乳酸阈区 | 90-105% | 阈值跑、巡航间歇 |
| Z5 | 速度耐力区 | 105-120% | VO2max 间歇、400-800m 重复 |
| Z6 | 无氧动力区 | >120% | 短冲、200m 全力跑 |

**功能点（v1.1 新增）**：

- **F7.1 功率数据采集**：解析 COROS `get_activity_detail` 返回的 `Average Power`（avgPower），写入 `activityDetails[].avgPower`
- **F7.2 FTP 自动估算**：`lib/power-utils.js#estimateFTP()` 用最近 3 次有效户外跑历史估算 FTP，输出 ftpW、ftpWkg、置信度（high/medium/low/none）
- **F7.3 功率区间展示**：报告"配速 & 心率 & 功率区间参考"区中，功率表按 FTP 百分比自动推导各区间瓦特范围
- **F7.4 功率教练解读**：LLM 上下文注入 avgPower + powerWkg + powerZone + FTP，prompt 中新增"跑步功率分析原则"段，DeepSeek 据此给出经济性/强度匹配建议
- **F7.5 关键指标卡片**：报告头部新增"平均功率（最近跑步）"和"估算 FTP"卡片

**数据约束**：

- 仅户外跑（sportType=100）有 avgPower；力量训练/无功率设备无数据
- COROS 跑步不返回 Normalized Power (NP)，无逐秒功率数据；高阶指标（VI/EF/W'bal）暂不支持

**功能点（v1.4 新增）**：

- **F8.1 训练计划自动推送**：`push-plan.py` 读取 analysis JSON 的 `weeklyPlan`，优先使用 LLM 生成的 `workoutSteps`（确保与报告中的详细计划一致），无 `workoutSteps` 时回退到规则引擎。直接调用 `coros_api` 模块推送到手表日历
- **F8.2 workoutSteps 结构化输出**：LLM 在 weeklyPlan 中输出 `workoutSteps[]` 数组，每步含 kind/targetDistanceKm/pace，确保推送计划与报告详细计划完全一致
- **F8.3 规则引擎回退**：当 weeklyPlan 无 `workoutSteps` 时（历史分析文件），根据训练类型自动生成步骤，配速从 paceZones 取值
- **F8.4 安全确认机制**：`--confirm` 标志区分预览和实际推送，默认 dry-run

### 24 周备战计划

| 阶段 | 周数 | 周跑量 | 重点 |
|------|------|--------|------|
| 准备期 | W0 | 45-60 km | 建立基础跑量、维持有氧 |
| 基础期 I | W1-W8 | 50-65 km | 有氧耐力、建立跑量 |
| 基础期 II | W9-W16 | 65-80 km | 节奏跑引入、MLD |
| 强化期 | W17-W20 | 75-90 km | 间歇、阈值、MP 配速 |
| 巅峰期 | W21-W22 | 80-85 km | 最长 LSD、MP 实战 |
| 减量期 | W23-W24 | 50→30 km | 减量保状态 |

### 训练安排偏好

- 间歇跑、节奏跑等强度课：周三或周四
- LSD（长距离慢跑）：周六或周日
- 节假日当天：可安排节奏跑、间歇跑或 LSD 等强度课
- 其他日期：轻松跑或休息

### 恢复调整机制

- 恢复绿灯：计划不变（系数 ×1.0）
- 恢复黄灯：距离降 20%，配速降一档（系数 ×0.8）
- 恢复红灯：距离降 40%，严格控制心率（系数 ×0.6）

### 恢复评估依据

| 指标 | 绿灯 | 黄灯 | 红灯 |
|------|------|------|------|
| HRV 连续低于正常 | 0-1 天 | 2 天 | ≥3 天 |
| 恢复度 | ≥85% | 70-85% | <70% |
| 深睡比例 | ≥20% | 18-20% | <18% |

---

## 5. 非功能需求

| 项目 | 要求 |
|------|------|
| 数据安全 | 凭据不提交 git（coros.config.json、.crs-token/ 已在 .gitignore） |
| 隐私 | 位置坐标仅用于分析，不在报告中展示 |
| 性能 | 单次全流程（采集+分析+报告）< 3 分钟 |
| 可靠性 | MCP 调用失败不影响其他数据项采集 |
| 兼容性 | macOS 环境，Node.js ESM 模块 |
| 离线可用 | Chart.js 本地化，断网也能查看报告 |
| LLM 提供商 | 主要使用 DeepSeek（deepseek-v4-pro），支持 fallback 切换 |