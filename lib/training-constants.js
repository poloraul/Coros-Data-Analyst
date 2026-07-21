export const MARATHON_DATE = new Date(2026, 11, 6);
export const MARATHON_TARGET_PACE = "4:58";
export const MARATHON_TARGET_TIME = "3:30:00";
export const LACTATE_THRESHOLD_HR = 170;

/** COROS 运动类型：跑步类，徒步/登山/力量等非跑步类型不纳入分析 */
export const RUNNING_SPORT_TYPES = [100, 101, 102, 110];
//   100 = Outdoor Run (户外跑)
//   101 = Track Run (场地跑)
//   102 = Trail Run (越野跑)
//   110 = Treadmill Run (跑步机)

export const PHASES = [
  { name: "基础期 I", startWeek: 1, endWeek: 8, weeklyKm: [50, 65], focus: "有氧耐力、建立跑量" },
  { name: "基础期 II", startWeek: 9, endWeek: 16, weeklyKm: [65, 80], focus: "节奏跑引入、MLD" },
  { name: "强化期", startWeek: 17, endWeek: 20, weeklyKm: [75, 90], focus: "间歇、阈值、MP配速" },
  { name: "巅峰期", startWeek: 21, endWeek: 22, weeklyKm: [80, 85], focus: "最长LSD、MP实战" },
  { name: "减量期", startWeek: 23, endWeek: 24, weeklyKm: [50, 30], focus: "减量保状态" },
];
