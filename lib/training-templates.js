/**
 * 训练计划模板（共用模块）
 *
 * 6 个训练阶段的周计划模板，用于 LLM 不可用时的降级规则引擎。
 * 每个阶段包含 7 天的模板（周一到周日）。
 */

export const PHASE_TEMPLATES = {
  "准备期": [
    { type: "轻松跑", dist: 8, pace: "6:00-6:20", hr: "<135", desc: "有氧基础" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "恢复" },
    { type: "中长距离", dist: 10, pace: "5:40-6:00", hr: "<145", desc: "有氧耐力" },
    { type: "休息/交叉", dist: 0, pace: "-", hr: "-", desc: "恢复或力量" },
    { type: "轻松跑+ST", dist: 8, pace: "5:50-6:10", hr: "<140", desc: "有氧+加速跑" },
    { type: "LSD", dist: 14, pace: "6:00-6:30", hr: "<140", desc: "长距离慢跑" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "完全休息" },
  ],
  "基础期 I": [
    { type: "轻松跑", dist: 8, pace: "6:00-6:20", hr: "<135", desc: "有氧基础" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "恢复" },
    { type: "中长距离", dist: 10, pace: "5:40-6:00", hr: "<145", desc: "有氧耐力" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "恢复" },
    { type: "轻松跑+ST", dist: 8, pace: "5:50-6:10", hr: "<140", desc: "有氧+加速跑" },
    { type: "LSD", dist: 15, pace: "6:00-6:30", hr: "<140", desc: "长距离慢跑" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "完全休息" },
  ],
  "基础期 II": [
    { type: "轻松跑", dist: 8, pace: "5:50-6:10", hr: "<135", desc: "有氧基础" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "恢复" },
    { type: "节奏跑", dist: 10, pace: "5:10-5:30", hr: "145-160", desc: "阈值耐力" },
    { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "中长距离", dist: 10, pace: "5:40-6:00", hr: "<145", desc: "有氧耐力" },
    { type: "LSD", dist: 18, pace: "5:50-6:20", hr: "<145", desc: "长距离慢跑" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "完全休息" },
  ],
  "强化期": [
    { type: "轻松跑", dist: 8, pace: "5:50-6:10", hr: "<135", desc: "有氧基础" },
    { type: "间歇", dist: 11, pace: "4:25-4:40(组)", hr: "165-175", desc: "5×1000m间歇" },
    { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "节奏跑", dist: 10, pace: "5:00-5:20", hr: "150-160", desc: "阈值耐力" },
    { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "MP长跑", dist: 16, pace: "5:00-5:10(MP)", hr: "150-160", desc: "马拉松配速跑" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "完全休息" },
  ],
  "巅峰期": [
    { type: "轻松跑", dist: 8, pace: "5:50-6:10", hr: "<135", desc: "有氧基础" },
    { type: "间歇", dist: 11, pace: "4:20-4:35(组)", hr: "165-178", desc: "5×1000m间歇" },
    { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "MP+节奏", dist: 12, pace: "4:55-5:15", hr: "150-162", desc: "MP+阈值组合" },
    { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "LSD", dist: 32, pace: "5:50-6:20", hr: "<150", desc: "最长距离LSD" },
    { type: "休息", dist: 0, pace: "-", hr: "-", desc: "完全休息" },
  ],
  "减量期": [
    { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<135", desc: "保持状态" },
    { type: "轻松跑+ST", dist: 6, pace: "5:50-6:10", hr: "<140", desc: "保持状态" },
    { type: "MP配速", dist: 8, pace: "4:55-5:05", hr: "150-158", desc: "比赛配速感" },
    { type: "轻松跑", dist: 5, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "轻松跑", dist: 5, pace: "6:00-6:20", hr: "<130", desc: "恢复跑" },
    { type: "轻松跑", dist: 3, pace: "6:00-6:20", hr: "<130", desc: "赛前激活" },
    { type: "比赛日", dist: 42, pace: "4:58", hr: "比赛", desc: "首马330!" },
  ],
};