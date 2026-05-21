#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");

// --- 330 Marathon 24-week training framework ---
const MARATHON_DATE = new Date(2026, 11, 6); // Dec 6, 2026
const MARATHON_TARGET_PACE = "4:58"; // /km for 3:30 marathon
const MARATHON_TARGET_TIME = "3:30:00";

const PHASES = [
  { name: "基础期 I", startWeek: 1, endWeek: 8, weeklyKm: [50, 65], focus: "有氧耐力、建立跑量", keySessions: ["轻松跑", "中长距离"] },
  { name: "基础期 II", startWeek: 9, endWeek: 16, weeklyKm: [65, 80], focus: "节奏跑引入、MLD", keySessions: ["轻松跑", "节奏跑", "中长距离"] },
  { name: "强化期", startWeek: 17, endWeek: 20, weeklyKm: [75, 90], focus: "间歇、阈值、MP配速", keySessions: ["间歇", "节奏跑", "MP跑", "LSD"] },
  { name: "巅峰期", startWeek: 21, endWeek: 22, weeklyKm: [80, 85], focus: "最长LSD、MP实战", keySessions: ["MP长跑", "LSD 32km"] },
  { name: "减量期", startWeek: 23, endWeek: 24, weeklyKm: [50, 30], focus: "减量保状态", keySessions: ["轻松跑", "少量MP"] },
];

// --- Utility ---
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { date: null, mode: "daily" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) parsed.date = args[++i];
    if (args[i] === "--mode" && args[i + 1]) parsed.mode = args[++i];
  }
  return parsed;
}

function paceToSeconds(pace) {
  if (!pace) return 0;
  const parts = pace.split(":");
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function secondsToPace(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getAge(birthday) {
  const today = new Date();
  const birth = new Date(birthday);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

function weeksUntilMarathon() {
  const now = new Date();
  const diff = MARATHON_DATE - now;
  return Math.max(0, Math.ceil(diff / (7 * 86400000)));
}

function getCurrentPhase(weeksLeft) {
  const totalWeeks = 24;
  if (weeksLeft > totalWeeks) {
    return { name: "准备期", startWeek: 0, endWeek: 0, weeklyKm: [45, 60], focus: "建立基础跑量、维持有氧", currentWeek: 0, weeksUntilPlan: weeksLeft - totalWeeks };
  }
  const weekNum = totalWeeks - weeksLeft + 1;
  for (const phase of PHASES) {
    if (weekNum >= phase.startWeek && weekNum <= phase.endWeek) {
      return { ...phase, currentWeek: weekNum };
    }
  }
  return { ...PHASES[PHASES.length - 1], currentWeek: weekNum };
}

// --- Analysis Modules ---

function reviewWorkout(activity, thresholdPace, maxHR) {
  if (!activity) return null;
  const tp = paceToSeconds(thresholdPace);
  const ap = paceToSeconds(activity.avgPace);
  // paceRatio: avgPace/thresholdPace in seconds. Higher = slower (easier).
  const paceRatio = tp > 0 ? ap / tp : 0;
  const hrPct = maxHR > 0 ? (activity.avgHR / maxHR) * 100 : 0;

  let intensityZone = "未知";
  if (paceRatio > 1.15) intensityZone = "轻松跑 (E区)";
  else if (paceRatio > 1.05) intensityZone = "有氧耐力 (E-M区)";
  else if (paceRatio > 0.98) intensityZone = "节奏跑 (T区)";
  else if (paceRatio > 0.92) intensityZone = "阈值跑 (T-I区)";
  else intensityZone = "间歇区 (I区)";

  const cadenceGap = activity.avgCadence ? Math.max(0, 180 - activity.avgCadence) : null;

  return {
    date: activity.date,
    distance: activity.distance,
    duration: activity.workoutTime,
    avgPace: activity.avgPace,
    bestKm: activity.bestKm,
    avgHR: activity.avgHR,
    avgCadence: activity.avgCadence,
    trainingLoad: activity.trainingLoad,
    performance: activity.performance,
    paceVsThreshold: paceRatio,
    paceVsThresholdDesc: paceRatio > 1.1 ? "低于阈值（轻松跑）" : paceRatio > 1.0 ? "略低于阈值" : paceRatio > 0.95 ? "接近阈值" : "达到/超过阈值",
    intensityZone,
    hrPctMax: Math.round(hrPct),
    cadenceGap,
  };
}

function assessRecovery(data) {
  const hrvDays = data.hrv?.days || [];
  const baseline = data.hrv?.baseline || 60;
  const normalLow = data.hrv?.normalRange?.[0] || 50;
  const recovery = data.recovery;

  // Count consecutive days below normal
  let consecutiveBelow = 0;
  for (const day of hrvDays) {
    if (day.hrv < normalLow) consecutiveBelow++;
    else break;
  }

  // Latest sleep
  const latestSleep = data.sleep?.[data.sleep.length - 1] || data.dailyHealth?.[data.dailyHealth.length - 1];
  const deepSleepPct = latestSleep?.deepRatio ?? (latestSleep?.deepSleep ? parseSleepPct(latestSleep.deepSleep, latestSleep.sleepTotal) : null);

  // Recovery level
  let level = "green";
  const reasons = [];
  if (consecutiveBelow >= 3) { level = "red"; reasons.push(`HRV连续${consecutiveBelow}天低于正常范围`); }
  else if (consecutiveBelow >= 2) { level = "yellow"; reasons.push(`HRV连续${consecutiveBelow}天低于正常范围`); }

  if (recovery?.percentage && recovery.percentage < 70) { level = "red"; reasons.push(`恢复度仅${recovery.percentage}%`); }
  else if (recovery?.percentage && recovery.percentage < 85) {
    if (level === "green") level = "yellow";
    reasons.push(`恢复度${recovery.percentage}%偏低`);
  }

  if (deepSleepPct !== null && deepSleepPct < 18) {
    if (level === "green") level = "yellow";
    reasons.push(`深睡比例${deepSleepPct}%偏低（建议>20%）`);
  }

  const latestHRV = hrvDays[0]?.hrv;
  const latestHRVEval = hrvDays[0]?.evaluation;

  return {
    level,
    reasons: reasons.length ? reasons : ["恢复状态良好"],
    recoveryPct: recovery?.percentage,
    recoveryLevel: recovery?.level,
    estimatedFullRecovery: recovery?.estimatedFullRecovery,
    latestHRV,
    latestHRVEval,
    hrvBaseline: baseline,
    hrvConsecutiveBelow: consecutiveBelow,
    deepSleepPct,
  };
}

function parseSleepPct(deepStr, totalStr) {
  // Approximate from text like "1h 49min" / "7h 16min"
  const parseTime = (s) => {
    const h = s.match(/(\d+)h/); const m = s.match(/(\d+)min/);
    return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
  };
  const deep = parseTime(deepStr);
  const total = parseTime(totalStr);
  return total > 0 ? Math.round((deep / total) * 100) : null;
}

function weeklyReview(data) {
  const records = data.sportRecords || [];
  const details = data.activityDetails || [];
  const loadEntries = data.trainingLoad || [];

  const totalKm = records.reduce((sum, r) => sum + (r.distance || 0), 0);
  const totalTL = details.reduce((sum, d) => sum + (d.trainingLoad || 0), 0);
  const runCount = records.filter(r => r.sportType === 100 || r.sportType === 101).length;

  // Intensity distribution
  let easy = 0, moderate = 0, hard = 0;
  const tp = paceToSeconds(data.fitness?.thresholdPace);
  for (const d of details) {
    const ap = paceToSeconds(d.avgPace);
    if (!ap || !tp) continue;
    const ratio = ap / tp;
    if (ratio > 1.08) easy += d.distance || 0;
    else if (ratio > 0.97) moderate += d.distance || 0;
    else hard += d.distance || 0;
  }

  const latestLoad = loadEntries[0];
  const loadRatio = latestLoad?.loadRatio;

  return {
    totalKm: Math.round(totalKm * 10) / 10,
    totalTL,
    runCount,
    easyKm: Math.round(easy * 10) / 10,
    moderateKm: Math.round(moderate * 10) / 10,
    hardKm: Math.round(hard * 10) / 10,
    loadRatio,
    shortTermLoad: latestLoad?.shortTermLoad,
    longTermLoad: latestLoad?.longTermLoad,
    loadComment: latestLoad?.comment,
  };
}

function generatePlan(data, weekly, recovery) {
  const weeksLeft = weeksUntilMarathon();
  const phase = getCurrentPhase(weeksLeft);
  const schedule = data.trainingSchedule || [];
  const records = data.sportRecords || [];

  // Calculate completed training this week
  const completedKm = weekly.totalKm;
  const completedRuns = weekly.runCount;

  // Target weekly km based on phase
  const targetKmMin = phase.weeklyKm[0];
  const targetKmMax = phase.weeklyKm[1];
  const remainingKmMin = Math.max(0, targetKmMin - completedKm);
  const remainingKmMax = Math.max(0, targetKmMax - completedKm);

  // Adjust based on recovery
  const recoveryMultiplier = recovery.level === "red" ? 0.6 : recovery.level === "yellow" ? 0.8 : 1.0;

  // Generate daily plan for remaining days
  const now = new Date();
  const dayOfWeek = now.getDay();
  const today = dayOfWeek === 0 ? 7 : dayOfWeek; // 1=Mon ... 7=Sun

  const weekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const days = [];

  // Typical week template adjusted by phase
  const templates = {
    "准备期": [
      { type: "轻松跑", dist: 8, pace: "6:00-6:20", hr: "<135" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
      { type: "中长距离", dist: 10, pace: "5:40-6:00", hr: "<145" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
      { type: "轻松跑+ST", dist: 8, pace: "5:50-6:10", hr: "<140" },
      { type: "LSD", dist: 14, pace: "6:00-6:30", hr: "<140" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
    ],
    "基础期 I": [
      { type: "轻松跑", dist: 8, pace: "6:00-6:20", hr: "<135" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
      { type: "中长距离", dist: 10, pace: "5:40-6:00", hr: "<145" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
      { type: "轻松跑+ST", dist: 8, pace: "5:50-6:10", hr: "<140" },
      { type: "LSD", dist: 15, pace: "6:00-6:30", hr: "<140" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
    ],
    "基础期 II": [
      { type: "轻松跑", dist: 8, pace: "5:50-6:10", hr: "<135" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
      { type: "节奏跑", dist: 10, pace: "5:10-5:30", hr: "145-160" },
      { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130" },
      { type: "中长距离", dist: 10, pace: "5:40-6:00", hr: "<145" },
      { type: "LSD", dist: 18, pace: "5:50-6:20", hr: "<145" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
    ],
    "强化期": [
      { type: "轻松跑", dist: 8, pace: "5:50-6:10", hr: "<135" },
      { type: "间歇", dist: 11, pace: "4:25-4:40(组)", hr: "165-175" },
      { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130" },
      { type: "节奏跑", dist: 10, pace: "5:00-5:20", hr: "150-160" },
      { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130" },
      { type: "MP长跑", dist: 16, pace: "5:00-5:10(MP)", hr: "150-160" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
    ],
    "巅峰期": [
      { type: "轻松跑", dist: 8, pace: "5:50-6:10", hr: "<135" },
      { type: "间歇", dist: 11, pace: "4:20-4:35(组)", hr: "165-178" },
      { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130" },
      { type: "MP+节奏", dist: 12, pace: "4:55-5:15", hr: "150-162" },
      { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<130" },
      { type: "LSD", dist: 32, pace: "5:50-6:20", hr: "<150" },
      { type: "休息", dist: 0, pace: "-", hr: "-" },
    ],
    "减量期": [
      { type: "轻松跑", dist: 6, pace: "6:00-6:20", hr: "<135" },
      { type: "轻松跑+ST", dist: 6, pace: "5:50-6:10", hr: "<140" },
      { type: "MP配速", dist: 8, pace: "4:55-5:05", hr: "150-158" },
      { type: "轻松跑", dist: 5, pace: "6:00-6:20", hr: "<130" },
      { type: "轻松跑", dist: 5, pace: "6:00-6:20", hr: "<130" },
      { type: "轻松跑", dist: 3, pace: "6:00-6:20", hr: "<130" },
      { type: "比赛日", dist: 42, pace: "4:58", hr: "比赛" },
    ],
  };

  const template = templates[phase.name] || templates["基础期 I"];

  // Build full 7-day plan (Mon-Sun)
  for (let d = 1; d <= 7; d++) {
    const t = template[d - 1];
    if (!t) continue;

    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() + (d - today));
    const dayStr = dayDate.toISOString().slice(0, 10);

    const isPast = d < today;
    const isToday = d === today;
    const completed = records.find(r => r.date === dayStr);

    if (completed) {
      days.push({
        dayIndex: d, dayName: weekDays[d - 1], date: dayStr, isPast: true, isToday,
        type: `✅ ${completed.distance}km`, distance: completed.distance,
        pace: completed.avgPace, hrZone: `${completed.avgHR} bpm`, isCompleted: true,
      });
    } else if (isPast) {
      days.push({
        dayIndex: d, dayName: weekDays[d - 1], date: dayStr, isPast: true, isToday: false,
        type: "休息", distance: 0, pace: "-", hrZone: "-", isCompleted: false,
      });
    } else {
      const adjustedDist = t.type === "休息" ? 0 : Math.round(t.dist * recoveryMultiplier);
      const adjustedPace = recovery.level !== "green" && t.type !== "休息" ? "降低一档" : t.pace;
      const adjustedHR = recovery.level === "red" && t.type !== "休息" ? "严格控制" : t.hr;
      days.push({
        dayIndex: d, dayName: weekDays[d - 1], date: dayStr, isPast: false, isToday,
        type: t.type, distance: adjustedDist, pace: adjustedPace, hrZone: adjustedHR, isCompleted: false,
      });
    }
  }

  const plannedRemainingKm = days.filter(d => !d.isCompleted).reduce((s, d) => s + d.distance, 0);
  const projectedTotalKm = Math.round((completedKm + plannedRemainingKm) * 10) / 10;

  return {
    weeksLeft,
    currentPhase: phase.name,
    currentWeek: phase.currentWeek,
    phaseFocus: phase.focus,
    targetWeeklyKm: `${targetKmMin}-${targetKmMax}km`,
    completedKm,
    remainingDays: days,
    projectedTotalKm,
    recoveryMultiplier,
    marathonPace: MARATHON_TARGET_PACE,
    marathonTarget: MARATHON_TARGET_TIME,
  };
}

// --- Report Generation ---

function generateMarkdownReport(data) {
  const user = data.userInfo || {};
  const fitness = data.fitness || {};
  const maxHR = 220 - getAge(user.birthday || "1990-01-01");
  const tp = fitness.thresholdPace || "4:37";

  // Individual workout reviews
  const workoutReviews = (data.activityDetails || []).map(d => reviewWorkout(d, tp, maxHR)).filter(Boolean);

  // Recovery assessment
  const recovery = assessRecovery(data);

  // Weekly review
  const weekly = weeklyReview(data);

  // Training plan
  const plan = generatePlan(data, weekly, recovery);

  // Build markdown
  let md = "";
  md += `# COROS 训练复盘与计划\n\n`;
  md += `> 生成时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} | 数据日期: ${data.fetchDate}\n\n`;

  // --- User profile & fitness ---
  md += `## 个人概况\n\n`;
  md += `| 指标 | 值 |\n|------|----|\n`;
  md += `| 年龄 | ${getAge(user.birthday)}岁 |\n`;
  md += `| 身高/体重 | ${user.height}cm / ${user.weight}kg |\n`;
  md += `| VO2max | ${fitness.vo2max || "-"} |\n`;
  md += `| 阈值配速 | ${fitness.thresholdPace || "-"} /km |\n`;
  md += `| 10km预测 | ${fitness.pred10k || "-"} |\n`;
  md += `| 半马预测 | ${fitness.predHalfMarathon || "-"} |\n`;
  md += `| 全马预测 | ${fitness.predMarathon || "-"} |\n`;
  md += `| 距首马 | **${plan.weeksLeft}周** (${plan.currentPhase} W${plan.currentWeek}) |\n\n`;

  // --- Recovery status ---
  const levelEmoji = { green: "🟢", yellow: "🟡", red: "🔴" };
  md += `## 恢复评估 ${levelEmoji[recovery.level]}\n\n`;
  md += `| 指标 | 值 | 状态 |\n|------|----|----|\n`;
  md += `| 恢复度 | ${recovery.recoveryPct || "-"}% | ${recovery.recoveryLevel || "-"} |\n`;
  md += `| 预计完全恢复 | ${recovery.estimatedFullRecovery || "-"} | |\n`;
  md += `| 最新HRV | ${recovery.latestHRV || "-"} ms | ${recovery.latestHRVEval || "-"} |\n`;
  md += `| HRV基线 | ${recovery.hrvBaseline} ms | 正常范围: ${data.hrv?.normalRange?.join("-") || "-"} ms |\n`;
  md += `| 连续低于正常 | ${recovery.hrvConsecutiveBelow}天 | ${recovery.hrvConsecutiveBelow >= 2 ? "⚠️ 注意" : "正常"} |\n`;
  if (recovery.deepSleepPct) md += `| 深睡比例 | ${recovery.deepSleepPct}% | ${recovery.deepSleepPct < 20 ? "⚠️ 偏低" : "正常"} |\n`;
  md += `\n**综合评估**: ${recovery.reasons.join("；")}\n\n`;

  // --- Workout reviews ---
  if (workoutReviews.length > 0) {
    // Deep review for latest workout
    const latest = workoutReviews[0];
    const latestDetail = data.activityDetails?.[0];
    md += `## 最近训练深度复盘\n\n`;
    md += `**${latest.date} | ${latest.distance}km | ${latest.duration}**\n\n`;
    md += `| 指标 | 值 | 分析 |\n|------|----|----|\n`;
    md += `| 平均配速 | ${latest.avgPace} /km | ${latest.paceVsThresholdDesc} (${(latest.paceVsThreshold * 100).toFixed(0)}%阈值配速) |\n`;
    md += `| 最快公里 | ${latest.bestKm || "-"} /km | 配速稳定性参考 |\n`;
    md += `| 强度区间 | ${latest.intensityZone} | |\n`;
    md += `| 平均心率 | ${latest.avgHR} bpm | ${latest.hrPctMax}% HRmax |\n`;
    md += `| 步频 | ${latest.avgCadence || "-"} spm | ${latest.cadenceGap ? `低于180目标${latest.cadenceGap}spm` : "达标"} |\n`;
    md += `| 训练负荷 | ${latest.trainingLoad || "-"} TL | |\n`;
    md += `| 表现评级 | ${latest.performance || "-"} | |\n\n`;

    // Detailed analysis
    const findings = [];
    const positives = [];
    const improvements = [];

    const ap = paceToSeconds(latest.avgPace);
    const bp = paceToSeconds(latest.bestKm);
    const tpSec = paceToSeconds(tp);
    const ratio = ap / tpSec;

    if (ratio > 1.05 && ratio <= 1.15) {
      findings.push(`配速${latest.avgPace}/km，为阈值配速的${(ratio * 100).toFixed(0)}%，中高强度有氧训练`);
      if (bp && ap - bp < 20) positives.push(`配速控制稳定，最快/平均公里差仅${secondsToPace(ap - bp)}`);
      else if (bp) improvements.push(`配速波动较大（最快${secondsToPace(bp)} vs 平均${latest.avgPace}），建议关注匀速`);
    } else if (ratio > 1.15) {
      findings.push(`配速${latest.avgPace}/km，轻松跑强度（${(ratio * 100).toFixed(0)}%阈值），有氧基础训练`);
      positives.push("轻松跑强度，有助于有氧基础建设");
    } else {
      findings.push(`配速${latest.avgPace}/km，接近阈值强度（${(ratio * 100).toFixed(0)}%阈值），高强度训练`);
    }

    const hrPct = latest.hrPctMax;
    if (hrPct > 85) improvements.push("心率偏高（>85% HRmax），注意控制强度避免过度训练");
    else positives.push(`心率${hrPct}% HRmax，强度控制合理`);

    if (latest.cadenceGap && latest.cadenceGap > 5) improvements.push(`步频${latest.avgCadence}spm偏低，建议提升至180+spm（差${latest.cadenceGap}spm）`);
    else if (latest.avgCadence >= 180) positives.push(`步频${latest.avgCadence}spm达标`);

    if (latestDetail?.trainingLoad > 150) findings.push(`训练负荷${latestDetail.trainingLoad}TL，属高负荷单次训练，需确保48h恢复`);

    // Compare with Coros plan
    const corosPlan = data.trainingSchedule?.find(s => s.date === latest.date);
    if (corosPlan) {
      findings.push(`Coros计划：${corosPlan.distance}km / ${corosPlan.estimatedTime} / ${corosPlan.load}TL`);
      if (latestDetail?.trainingLoad && corosPlan.load) {
        const overload = Math.round(((latestDetail.trainingLoad - corosPlan.load) / corosPlan.load) * 100);
        if (overload > 10) improvements.push(`实际负荷超出计划${overload}%，建议严格按计划配速执行`);
        else positives.push(`训练负荷与计划基本一致`);
      }
    }

    md += `**训练分析**: ${findings.join("；")}\n\n`;
    if (positives.length) md += `**亮点**: ${positives.join("；")}\n\n`;
    if (improvements.length) md += `**改进方向**: ${improvements.join("；")}\n\n`;

    // Other workouts summary
    if (workoutReviews.length > 1) {
      md += `### 其他近期训练\n\n`;
      for (let i = 1; i < workoutReviews.length; i++) {
        const w = workoutReviews[i];
        md += `- **${w.date}** ${w.distance}km ${w.avgPace}/km | HR ${w.avgHR}bpm (${w.hrPctMax}%HRmax) | ${w.intensityZone} | ${w.trainingLoad || "-"}TL | ${w.performance || "-"}\n`;
      }
      md += `\n`;
    }
  }

  // --- Weekly summary ---
  md += `## 周训练概览\n\n`;
  md += `| 指标 | 值 |\n|------|----|\n`;
  md += `| 本周跑量 | ${weekly.totalKm}km (目标: ${plan.targetWeeklyKm}) |\n`;
  md += `| 跑步次数 | ${weekly.runCount}次 |\n`;
  md += `| 总训练负荷 | ${weekly.totalTL} TL |\n`;
  md += `| 负荷比(短/长) | ${weekly.loadRatio || "-"} (${weekly.loadComment || "-"}) |\n`;
  md += `| 强度分布 | 轻松${weekly.easyKm}km / 中等${weekly.moderateKm}km / 高强度${weekly.hardKm}km |\n\n`;

  // --- Training plan ---
  md += `## 本周训练计划\n\n`;
  md += `**当前阶段**: ${plan.currentPhase}${plan.currentWeek > 0 ? ` (W${plan.currentWeek})` : ""} — ${plan.phaseFocus}\n\n`;
  md += `已完成 ${plan.completedKm}km | 目标 ${plan.targetWeeklyKm} | 恢复调整系数 ×${plan.recoveryMultiplier}\n\n`;

  if (plan.remainingDays.length > 0) {
    md += `| 日期 | 类型 | 距离 | 配速 | 心率区间 | 状态 |\n|------|------|------|------|----------|------|\n`;
    for (const day of plan.remainingDays) {
      const status = day.isCompleted ? "✅ 已完成" : day.isToday ? "📍 今天" : "";
      md += `| ${day.dayName} ${day.date.slice(5)} | ${day.type} | ${day.distance > 0 ? day.distance + "km" : "-"} | ${day.pace} | ${day.hrZone} | ${status} |\n`;
    }
    md += `\n**预计周总跑量**: ${plan.projectedTotalKm}km (目标: ${plan.targetWeeklyKm})\n\n`;
  }

  // --- Key reminders ---
  md += `## 关键提醒\n\n`;
  if (recovery.level === "red") {
    md += `1. **恢复优先**: 当前恢复状态不佳，建议降级训练强度或安排完全休息日\n`;
  }
  if (recovery.hrvConsecutiveBelow >= 2) {
    md += `2. **HRV预警**: HRV连续${recovery.hrvConsecutiveBelow}天偏低，自主神经系统疲劳累积中，注意睡眠和营养补充\n`;
  }
  const cadenceIssues = workoutReviews.filter(w => w.cadenceGap && w.cadenceGap > 3);
  if (cadenceIssues.length > 0) {
    md += `3. **步频提升**: 最近${cadenceIssues.length}次训练步频低于177spm，每次跑步前10分钟专注180+spm步频练习\n`;
  }
  md += `4. **330目标配速**: ${plan.marathonPace}/km — 当前阈值配速${tp}/km，需逐步提升至4:20-4:25/km\n`;
  md += `5. **Yasso 800参考**: 3:30/800m（对应330全马），可作为间歇训练配速参考\n`;

  return md;
}

// --- Main ---
const args = parseArgs();
const dateFile = args.date || (() => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
})();

const dataPath = path.join(DATA_DIR, `${dateFile}.json`);

if (!existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  console.error(`Run 'node scripts/fetch.js' first to fetch data.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataPath, "utf-8"));
const report = generateMarkdownReport(data);
console.log(report);
