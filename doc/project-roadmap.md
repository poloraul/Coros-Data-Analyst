# 项目规划文档

## 1. 项目状态概览

**当前阶段**：V1 已可用，已通过架构重构消除技术债，处于日常使用 + 迭代优化阶段

**核心流程已实现**：
- 数据采集 → TCX 下载 → LLM 分析 → 数据验证 → HTML 报告 → 定时调度
- 24 周马拉松备战训练框架
- 恢复评估驱动的训练计划调整
- COROS 6 区配速/心率系统
- 中国法定节假日感知
- 训练偏好配置（强度课排期规则）

---

## 2. 已完成功能

### V1.0 — 基础闭环（已完成）

| 功能 | 状态 | 说明 |
|------|------|------|
| 数据采集 | ✅ | 10 项 Coros MCP 数据采集 + 文本解析 |
| 数据增量获取 | ✅ | 同天二次运行仅刷新运动记录，其余数据复用 |
| TCX 下载 | ✅ | crs-connect SDK 登录下载，Token 缓存，增量更新 |
| TCX 基础分析 | ✅ | 分段/漂移/心率分区/步频/海拔 |
| LLM 深度复盘 | ✅ | 多 provider 支持（deepseek/anthropic/openai/qianfan） |
| LLM 分析去重 | ✅ | 数据未变时跳过 LLM 调用，--force 强制重新分析 |
| LLM 备用切换 | ✅ | 主 LLM 限流自动切换 fallback |
| HTML 报告 | ✅ | Chart.js 图表（本地加载）+ 亮暗主题 |
| 训练计划框架 | ✅ | 24 周 6 阶段 + 恢复调整系数 |
| 自动化调度 | ✅ | macOS launchd + Claude Code Workflow |

### V1.1 — 数据质量保障（2026-06-15）

| 功能 | 状态 | 说明 |
|------|------|------|
| 数据完整性修复 | ✅ | `reconcileFromTCX()` 双向比对 sportRecords 与 activityDetails，缺失项通过 TCX 补全 |
| 数据验证脚本 | ✅ | `validate.js` 自动检查配速趋势、数据引用一致性 |
| 配速区间一致性 | ✅ | 报告中的配速区间自动从详细计划推导，消除 LLM 输出不一致 |
| 近7天滑动窗口 | ✅ | 进度条和训练一览表使用近7天滑动窗口，不受自然周限制 |

### V1.2 — 训练科学化（2026-06-15）

| 功能 | 状态 | 说明 |
|------|------|------|
| COROS 6 区配速系统 | ✅ | 配速区间基于乳酸阈配速 6 区标准（Z1-Z6） |
| COROS 6 区心率系统 | ✅ | 心率区间基于乳酸阈心率 6 区标准（LTHR 170 bpm） |
| 节假日感知 | ✅ | `lib/holidays.js` 基于 2026 年国务院放假安排，节假日可安排强度课 |
| 训练偏好规则 | ✅ | 强度课周三/周四，LSD 周末，已写入 LLM system prompt |
| DeepSeek 统一 | ✅ | Volcengine 废弃，统一使用 DeepSeek API |

### V1.3 — 架构重构（2026-06-15）

| 项目 | 状态 | 说明 |
|------|------|------|
| 死代码清理 | ✅ | 删除 `lib/context-builder.js`、`lib/tcx-advanced.js` |
| 共用模块抽取 | ✅ | `lib/recovery.js`、`lib/training-templates.js` |
| Token 成本优化 | ✅ | LLM 上下文压缩（zones 精简、 holidays 裁剪、过期比赛移除），节省 ~20% |
| Chart.js 本地化 | ✅ | CDN 改为本地加载，离线可用 |
| Workflow 验证优化 | ✅ | Phase 4 从 LLM Agent 改为 `validate.js` 脚本，节省 ~4 秒 |

---

## 3. 待优化/待开发功能

### 3.1 高优先级

| 编号 | 功能 | 描述 | 预期收益 |
|------|------|------|----------|
| P1 | 周报推送 | 每周日晚自动生成报告后推送到微信/邮件 | 不用每次手动打开 HTML |
| P2 | 趋势追踪 | 跨周数据对比，展示 VO2max/阈值配速/周跑量趋势 | 发现长期进步或停滞 |
| P3 | 异常告警 | HRV 连续 3 天偏低 / 负荷比 > 1.5 / 周跑量激增 > 30% 时主动提醒 | 避免过度训练受伤 |

### 3.2 中优先级

| 编号 | 功能 | 描述 | 预期收益 |
|------|------|------|----------|
| P4 | 训练计划与实际对比 | 将 Coros App 计划与实际完成逐项对比 | 量化执行率，识别偏差 |
| P5 | 跑步效率趋势 | 跨次训练的 REI 趋势图 | 追踪跑步经济性改善 |
| P6 | 天气/环境关联 | 记录训练时温湿度，分析环境对配速/心率影响 | 解释配速波动原因 |
| P7 | 比赛配速模拟 | 基于当前体能模拟不同策略下的全马表现 | 辅助比赛日策略制定 |

### 3.3 低优先级

| 编号 | 功能 | 描述 | 预期收益 |
|------|------|------|----------|
| P8 | 多用户支持 | 抽象用户配置，支持多跑者 | 分享给跑团使用 |
| P9 | Web Dashboard | 替代 HTML 报告的 Web 应用 | 更好的交互体验 |
| P10 | 社交分享 | 生成可分享的训练卡片图 | 跑圈打卡 |

---

## 4. 变更日志

### 2026-06-15 架构重构：死代码清理 + 共用模块 + Token 优化

**改动**：

| 文件 | 改动 |
|------|------|
| `lib/context-builder.js` | 删除（死代码，从未被 import） |
| `lib/tcx-advanced.js` | 删除（仅被死代码引用） |
| `lib/recovery.js` | 新建，从 `report.js` 提取共用恢复评估函数 |
| `lib/training-templates.js` | 新建，6 阶段周计划模板统一管理 |
| `lib/holidays.js` | 新建，2026 年中国法定节假日数据 + 查询工具 |
| `scripts/analyze.js` | 导入 `PHASE_TEMPLATES` 替代本地模板（-110 行）；新增 `compressZones()` 精简 LLM 上下文（-800B/次）；移除过期 `upcomingRace`；`holidays.upcoming` 裁剪至 4 周；训练偏好写入 system prompt |
| `scripts/report.js` | 导入 `assessRecovery` + `PHASE_TEMPLATES` 替代本地实现（-170 行）；新增 `extractPaceRange()` / `derivePaceZone()` 自动推导配速区间；近7天滑动窗口替换自然周；Chart.js 本地加载 |
| `scripts/validate.js` | 新建，纯 Node.js 数据校验脚本（替代 LLM Agent） |
| `.claude/workflows/daily-review.js` | Phase 4 改为 `node validate.js`；移除 volcengine 选项 |

**效果**：代码行数 -500 行，LLM 单次输入 -20% tokens，Workflow 验证耗时 -4 秒，Chart.js 离线可用。

### 2026-06-15 训练科学化：COROS 6 区 + 节假日 + 训练偏好

**改动**：

| 文件 | 改动 |
|------|------|
| `lib/zones.js` | `ZONE_LABELS` 从 5 区改为 6 区（积极恢复区/有氧耐力区/有氧动力区/乳酸阈区/速度耐力区/无氧动力区）；`calcPaceZones()` 边界改为 COROS 标准（71%/85%/93%/102%/112%）；`calcHRZones()` 边界改为 COROS LTHR 标准（80%/90%/96%/102%/106%）；`classifyPace()` 和 `classifyHR()` 更新为 6 区判定 |
| `lib/holidays.js` | 新建，基于国务院 2026 年放假安排，支持 `getHolidayAnnotations()` 和 `getHolidaysInRange()` |
| `scripts/analyze.js` | `buildLLMContext` 新增 `holidays` 字段；system prompt 新增训练偏好规则（强度课周三/周四 + LSD 周末 + 节假日强度课） |

### 2026-06-15 数据完整性修复：TCX 双向比对

**改动**：

| 文件 | 改动 |
|------|------|
| `scripts/fetch.js` | 新增 `reconcileFromTCX()`，遍历 sportRecords 查找有 TCX 但无 activityDetail 的记录，通过 TCX 解析自动补全 |
| `data/daily/20260615.json` | 06-10 的 9.75km 训练通过 TCX 补全了 activityDetails |

### 2026-05-25 LLM Token 优化：TCX 摘要压缩 + 上下文精简

**背景**：LLM 分析上下文 ~6.4KB，其中 TCX 原始数组数据占 64%，系统提示词冗长，单次分析耗时 ~2.5 分钟。

**改动**：

| 文件 | 改动 |
|------|------|
| `scripts/analyze.js` | 新增 `summarizeTcxMetrics()`，将原始 kmSplits/hrZones/hrDrift/cadence/paceCV 压缩为一行紧凑文本摘要（~400 字符替代 ~4KB）；`buildLLMContext()` 使用 `tcxSummary` 替代 `tcxMetrics`，删除冗余字段（racePredictions、gender、trend7d、estimatedFullRecovery）；系统提示词精简（原则 4→3 条，JSON schema 内联描述缩短，删除冗余反例段落） |
| `lib/llm.js` | jsonMode 保持 false（DeepSeek json_object 模式输出不稳定） |
| `coros.config.json` | maxTokens 保持 8192（输出分析 ~6000 字符，4096 不够） |

**效果**：上下文 5,731 → 1,562 字符（-73%），分析耗时 2:29 → 1:09（-54%），分析输出 5,680 → 4,074 字符（-28%）。

### 2026-05-23 性能优化：增量获取 + 分析去重 + LLM 备用切换

**背景**：每次执行全量拉取 10 个 MCP 调用 + 重复 LLM 分析，百度千帆调用超限后无备用方案。

**改动**：

| 文件 | 改动 |
|------|------|
| `scripts/fetch.js` | 新增 `fetchIncremental()`，同天二次运行仅刷新 sportRecords + activityDetails（2 次 MCP 调用代替 10 次），按 labelId 合并去重；新增 TCX 下载+解析流程，`tcxMetrics` 写入 daily JSON |
| `scripts/analyze.js` | 新增分析去重检查，已有 analysis JSON 且 workouts 未变时跳过 LLM 调用；新增 `--force` 参数；移除 TCX 解析逻辑，改为从 daily JSON 直接读取 `tcxMetrics` |
| `lib/llm.js` | 新增 fallback 机制，主 LLM 限流（429/rate/limit/配额）自动切换备用 LLM；支持 `config.apiKey` 直接写死 key |
| `coros.config.json` | 增加 `fallback` 字段配置 DeepSeek 备用模型 |

**关键设计决策**：
- 增量策略：每天首次全量，后续只刷新运动记录（变化快），HRV/恢复/睡眠等慢变数据复用
- 分析去重：对比 context 中 workouts 日期列表判断数据是否变化
- 架构调整：TCX 下载+解析移入 fetch.js，analyze.js 仅负责 LLM 复盘和计划生成
- API Key：DeepSeek key 直接写死在 config 中，不使用环境变量

---

## 5. 技术债务

| 项目 | 问题 | 建议处理方式 |
|------|------|-------------|
| ~~analyze.js 与 report.js 逻辑重复~~ | ✅ 已解决（抽取 lib/recovery.js + lib/training-templates.js） |
| ~~死代码~~ | ✅ 已解决（删除 lib/context-builder.js + lib/tcx-advanced.js） |
| fetch.js MCP 调用方式 | 通过 `execSync` 调用 `coros-mcp` CLI，效率低且阻塞 | 评估 MCP SDK 直连可能性 |
| report.js 内嵌大段 HTML | 模板与逻辑混在一起，维护困难 | 考虑模板引擎或组件化 |
| 无测试覆盖 | 核心计算逻辑（配速换算、HR 分区等）没有单元测试 | 为 lib/ 添加测试 |
| TCX 解析使用正则 | 大 XML 用正则解析不够健壮 | 考虑 XML parser |
| ~~PHASES 常量重复定义~~ | ✅ 已解决（统一在 lib/training-constants.js） |
| ~~Chart.js CDN 依赖~~ | ✅ 已解决（本地化到 reports/chart.min.js） |

---

## 6. 里程碑规划

### M1: 稳定化（已完成 ✅）

- 修复已知 bug
- 消除 analyze.js/report.js 重复逻辑
- 删除死代码
- 确保每日 cron 稳定运行
- Token 成本优化

### M2: 可视化增强（2026-06 → 2026-07）

- 趋势追踪图表（VO2max、阈值配速、周跑量）
- 训练计划执行率可视化
- 报告 UI 优化

### M3: 智能化（2026-07 → 2026-09）

- 异常告警机制
- 基于历史数据的训练建议优化
- 比赛配速模拟

### M4: 备战冲刺（2026-09 → 2026-12）

- 减量期专项报告
- 赛前一周专项指导
- 赛后复盘

---

## 7. 关键指标追踪

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| VO2max | 54 | ≥55 |
| 阈值配速 | 4:18/km | ≤4:20/km |
| 全马预测 | 3:18:18 | <3:30:00 ✅ 已达标 |
| 周跑量 | ~45 km（准备期） | 50-65 km（基础期 I） |
| 步频 | ~180 spm | ≥180 spm |
| 恢复度 | ~95% | 持续 ≥85% ✅ |