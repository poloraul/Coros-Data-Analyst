#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLLM } from "../lib/llm.js";
import { MARATHON_DATE, MARATHON_TARGET_PACE, MARATHON_TARGET_TIME, PHASES, LACTATE_THRESHOLD_HR } from "../lib/training-constants.js";
import { paceToSeconds, secondsToPace, getAge, weeksUntilMarathon, getCurrentPhase, getCurrentWeekBounds } from "../lib/training-utils.js";
import { calcPaceZones, calcHRZones } from "../lib/zones.js";
import { getHolidayAnnotations, getHolidaysInRange } from "../lib/holidays.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");

// --- Utility ---
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { date: null, mode: "daily", force: false, provider: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) parsed.date = args[++i];
    if (args[i] === "--mode" && args[i + 1]) parsed.mode = args[++i];
    if (args[i] === "--force") parsed.force = true;
    if (args[i] === "--provider" && args[i + 1]) parsed.provider = args[++i];
  }
  return parsed;
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
  const { start, end } = getCurrentWeekBounds();
  const records = (data.sportRecords || []).filter(r => r.date >= start && r.date <= end);
  const details = (data.activityDetails || []).filter(d => d.date >= start && d.date <= end);
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

  // Build 7-day plan starting from today
  const todayStr = now.toISOString().slice(0, 10);
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() + i);
    const dayStr = dayDate.toISOString().slice(0, 10);
    const tIdx = (today - 1 + i) % 7;
    const t = template[tIdx];
    if (!t) continue;

    const isToday = i === 0;
    const completed = records.find(r => r.date === dayStr);

    if (completed) {
      days.push({
        dayIndex: i + 1, dayName: weekDays[tIdx], date: dayStr, isPast: true, isToday,
        type: `✅ ${completed.distance}km`, distance: completed.distance,
        pace: completed.avgPace, hrZone: `${completed.avgHR} bpm`, isCompleted: true,
      });
    } else {
      const adjustedDist = t.type === "休息" ? 0 : Math.round(t.dist * recoveryMultiplier);
      const adjustedPace = recovery.level !== "green" && t.type !== "休息" ? "降低一档" : t.pace;
      const adjustedHR = recovery.level === "red" && t.type !== "休息" ? "严格控制" : t.hr;
      days.push({
        dayIndex: i + 1, dayName: weekDays[tIdx], date: dayStr, isPast: dayStr < todayStr, isToday,
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
  const workoutReviews = (data.activityDetails || []).map(d => reviewWorkout(d, tp, maxHR)).filter(Boolean).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

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

// --- TCX Metrics Summarizer ---

function summarizeTcxMetrics(metrics) {
  if (!metrics) return null;
  const parts = [];
  const splits = metrics.kmSplits || [];

  // Pace trend: first vs last km
  if (splits.length >= 2) {
    const first = splits[0];
    const last = splits[splits.length - 1];
    const paces = splits.map(s => s.paceSecPerKm).filter(p => p > 0);
    if (paces.length >= 2) {
      const paceDelta = last.paceSecPerKm - first.paceSecPerKm;
      let trend;
      if (paceDelta < -8) trend = "负分段加速";
      else if (paceDelta > 8) trend = "后程掉速";
      else if (Math.abs(paceDelta) <= 4) trend = "配速均匀";
      else trend = "配速波动";
      parts.push(`${trend}(${secondsToPace(first.paceSecPerKm)}→${secondsToPace(last.paceSecPerKm)})`);

      // Anomaly detection
      for (let i = 1; i < splits.length - 1; i++) {
        const neighborAvg = (splits[i - 1].paceSecPerKm + splits[i + 1].paceSecPerKm) / 2;
        if (splits[i].paceSecPerKm - neighborAvg > 15) {
          parts.push(`KM${splits[i].km}异常慢(+${Math.round(splits[i].paceSecPerKm - neighborAvg)}s)`);
          break;
        }
      }
    }
  }

  if (metrics.paceCV) {
    parts.push(`CV${metrics.paceCV.cvPct}%(${metrics.paceCV.evaluation})`);
  }

  // HR drift
  if (metrics.hrDrift) {
    parts.push(`HR${metrics.hrDrift.avgHRFirst}→${metrics.hrDrift.avgHRLast}漂移${metrics.hrDrift.driftPct}%`);
  }

  // HR zone distribution
  if (metrics.hrZones) {
    const z = (metrics.hrZones.pctZ1Z2 || 0) + (metrics.hrZones.pctZ3Z4 || 0) + (metrics.hrZones.pctZ5 || 0);
    if (z > 0) {
      parts.push(`Z:Z1-2 ${metrics.hrZones.pctZ1Z2}% Z3-4 ${metrics.hrZones.pctZ3Z4}% Z5 ${metrics.hrZones.pctZ5}% (主${metrics.hrZones.dominantZone})`);
    }
  }

  // Cadence
  if (metrics.cadence) {
    parts.push(`步频${metrics.cadence.avgCadence}(>180:${metrics.cadence.pctAbove180}%)`);
  }

  // Elevation (only when significant)
  if (metrics.elevation && metrics.elevation.totalGain > 20) {
    parts.push(`爬升+${metrics.elevation.totalGain}m`);
  }

  return parts.join("; ");
}

// --- LLM Integration ---

function loadLLMConfig(providerName) {
  const configPath = path.join(PROJECT_ROOT, "coros.config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const llm = config.llm || null;
    if (!llm) return null;
    if (providerName && llm.providers?.[providerName]) {
      return llm.providers[providerName];
    }
    if (providerName) {
      throw new Error(`Provider "${providerName}" not found in llm.providers. Available: ${Object.keys(llm.providers || {}).join(", ")}`);
    }
    return llm;
  } catch (e) {
    if (e.message?.includes("not found in llm.providers")) throw e;
    return null;
  }
}

/**
 * Build the LLM context object from daily JSON (TCX metrics already embedded).
 */
function buildLLMContext(data) {
  const user = data.userInfo || {};
  const fitness = data.fitness || {};
  const maxHR = 220 - getAge(user.birthday || "1990-01-01");
  const weeksLeft = weeksUntilMarathon();
  const phase = getCurrentPhase(weeksLeft);
  const records = data.sportRecords || [];
  const hrvDays = data.hrv?.days || [];
  const loadEntries = data.trainingLoad || [];
  const sleepData = data.dailyHealth || data.sleep || [];

  const now = new Date();
  const weekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const { start: wS, end: wE } = getCurrentWeekBounds();

  // Weekly summary inline (filtered by current week 周一→周日)
  const wRecs = records.filter(r => r.date >= wS && r.date <= wE);
  const wDetails = (data.activityDetails || []).filter(d => d.date >= wS && d.date <= wE);
  const totalKm = wRecs.reduce((s, r) => s + (r.distance || 0), 0);
  const totalTL = wDetails.reduce((s, d) => s + (d.trainingLoad || 0), 0);
  const runCount = wRecs.filter((r) => r.sportType === 100 || r.sportType === 101).length;

  // Build workouts with TCX summaries
  const workouts = (data.activityDetails || []).map((d) => ({
    date: d.date,
    distance: d.distance,
    duration: d.workoutTime,
    avgPace: d.avgPace,
    bestKm: d.bestKm,
    avgHR: d.avgHR,
    avgCadence: d.avgCadence,
    trainingLoad: d.trainingLoad,
    performance: d.performance,
    tcxSummary: summarizeTcxMetrics(d.tcxMetrics),
    weather: d.weather || null,
  }));

  return {
    profile: {
      age: getAge(user.birthday),
      height: user.height,
      weight: user.weight,
      vo2max: fitness.vo2max,
      thresholdPace: fitness.thresholdPace,
      maxHR,
    },
    goal: {
      targetTime: "3:30:00",
      targetPace: "4:58/km",
      marathonDate: "2026-12-06",
      weeksLeft,
      currentPhase: phase.name,
      currentWeek: phase.currentWeek,
      phaseFocus: phase.focus,
      targetWeeklyKm: phase.weeklyKm,
    },
    bodyStatus: {
      recovery: {
        percentage: data.recovery?.percentage,
        level: data.recovery?.level,
      },
      hrv: {
        baseline: data.hrv?.baseline,
        normalRange: data.hrv?.normalRange,
        latestValue: hrvDays[0]?.hrv,
        latestEval: hrvDays[0]?.evaluation,
        consecutiveBelow: (() => {
          let n = 0;
          for (const d of hrvDays) {
            if (d.hrv < (data.hrv?.normalRange?.[0] || 50)) n++;
            else break;
          }
          return n;
        })(),
      },
      sleep: {
        latestScore: sleepData[sleepData.length - 1]?.sleepScore,
        deepRatio: sleepData[sleepData.length - 1]?.deepRatio ?? data.sleep?.[data.sleep.length - 1]?.deepRatio,
      },
      trainingLoad: {
        shortTerm: loadEntries[0]?.shortTermLoad,
        longTerm: loadEntries[0]?.longTermLoad,
        ratio: loadEntries[0]?.loadRatio,
        comment: loadEntries[0]?.comment,
      },
    },
    paceZones: calcPaceZones(fitness.thresholdPace),
    hrZones: calcHRZones(LACTATE_THRESHOLD_HR, { useLTHR: true }),
    workouts,
    today: {
      date: now.toISOString().slice(0, 10),
      dayOfWeek: weekDays[now.getDay() === 0 ? 6 : now.getDay() - 1],
    },
    weeklySummary: {
      totalKm: Math.round(totalKm * 10) / 10,
      runCount,
      totalTL,
    },
    upcomingRace: {
      date: "2026-06-14",
      dayName: "周日",
      distanceKm: 10,
      targetTimeMinLow: 48,
      targetTimeMinHigh: 50,
      targetPace: "4:48-5:00/km",
      targetHRZone: "轻松跑 (Z2-Z3)",
      description: "10公里路跑，当作一次节奏跑课表，正常训练强度，不影响全马330备战计划"
    },
    holidays: {
      thisWeek: getHolidayAnnotations([...Array(7).keys()].map(i => {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        return d.toISOString().slice(0, 10);
      })),
      upcoming: getHolidaysInRange(now.toISOString().slice(0, 10), "2026-12-31"),
    },
  };
}

/**
 * Save analysis result to JSON file.
 */
function saveAnalysisJSON(dateFile, context, analysisResult) {
  const output = {
    fetchDate: dateFile,
    generatedAt: new Date().toISOString(),
    context,
    analysis: analysisResult,
  };

  const outPath = path.join(DATA_DIR, `${dateFile}-analysis.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Analysis saved to ${path.relative(PROJECT_ROOT, outPath)}`);
  return outPath;
}

// --- Main ---
async function main() {
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
    console.error("Run 'node scripts/fetch.js' first to fetch data.");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(dataPath, "utf-8"));
  data.activityDetails = (data.activityDetails || []).sort((a, b) => b.date.localeCompare(a.date));

  // Step 1: Build LLM context (tcxMetrics already in data from fetch.js)
  console.log("Building analysis context...");
  const context = buildLLMContext(data);
  const tcxCount = (data.activityDetails || []).filter(d => d.tcxMetrics).length;
  console.log(`  ${tcxCount}/${(data.activityDetails || []).length} workouts have TCX data`);

  // Step 1.5: Check if analysis already exists and data unchanged
  if (!args.force) {
    const analysisPath = path.join(DATA_DIR, `${dateFile}-analysis.json`);
    if (existsSync(analysisPath)) {
      try {
        const existing = JSON.parse(readFileSync(analysisPath, "utf-8"));
        const existingLabelIds = (existing.context?.workouts || []).map(w => w.date).filter(Boolean).sort();
        const currentLabelIds = (data.activityDetails || []).map(d => d.date).filter(Boolean).sort();
        if (existingLabelIds.length > 0 && JSON.stringify(existingLabelIds) === JSON.stringify(currentLabelIds)) {
          console.log("Analysis already exists and data unchanged, skipping LLM call.");
          console.log("Use --force to re-analyze.");
          const mdReport = generateMarkdownReport(data);
          console.log("\n" + mdReport);
          return;
        }
        console.log("New activities detected since last analysis, re-analyzing...");
      } catch {
        console.log("Could not parse existing analysis, re-analyzing...");
      }
    }
  }

  // Step 2: Try LLM analysis
  const llmConfig = loadLLMConfig(args.provider);
  let analysisResult = null;

  if (llmConfig) {
    try {
      console.log(`Initializing LLM (${llmConfig.provider}/${llmConfig.model})...`);
      const llm = createLLM(llmConfig);
      const systemPrompt = `你是资深跑步教练（CSCS认证），专精马拉松训练和运动生理学。

分析原则：
1. 数据驱动：基于tcxSummary中的配速趋势、心率漂移、区间分布、步频数据做量化分析
2. 目标导向：以首马3:30（配速4:58/km）为基准，评价训练方向
3. 具体可执行：改进建议必须给出具体配速范围、心率目标或步频要求
4. 环境因素：结合天气数据（温度、体感温度、湿度、天气描述）分析对训练表现的影响，高温高湿需调低期望，凉爽干燥利于发挥

注意：
1. weeklyPlan 是未来7天的训练计划，必须从报告日期当天（${context.today.date}，${context.today.dayOfWeek}）开始，dayIndex为1-7对应报告日期起的第几天，不能用下一个周一/周日起算。
2. ⚡${context.upcomingRace.date}（${context.upcomingRace.dayName}）有一场${context.upcomingRace.distanceKm}公里比赛，但对用户只是普通训练强度（当前10km预测42:31），请将周日作为一次节奏跑/比赛配速跑课表纳入正常训练计划，不需要赛前减量或特殊调整。整体计划应以全马330备战为主。
3. 这是一个正常训练周，包含一次周日10km节奏跑，其他训练照常进行，周跑量目标45-60km。
4. 训练安排偏好：
   - 间歇跑、节奏跑等强度课放在周三或周四
   - LSD（长距离慢跑）安排在周六或周日
   - 其他日期安排轻松跑或休息
5. 节假日安排：如果本周包含法定节假日（见holidays数据），节假日当天可以安排节奏跑、间歇跑或LSD等强度课，不必安排轻松跑或休息。

请输出严格JSON格式：

{
  "workoutReviews": [
    {
      "date": "YYYY-MM-DD",
      "summary": "训练概括（类型/距离/配速/表现）",
      "detailedAnalysis": "技术分析（100-200字）：引用tcxSummary数据和天气条件，分析配速趋势、心率漂移、区间分布、天气影响",
      "positives": ["具体亮点（需带数据支撑）"],
      "improvements": ["改进建议（需含具体配速/心率/步频数值）"]
    }
  ],
  "bodyAssessment": {
    "overallLevel": "green/yellow/red",
    "summary": "身体状态评估",
    "details": ["分项评估"],
    "recommendations": ["改善建议"]
  },
  "trainingPatternAnalysis": {
    "summary": "训练模式评价",
    "strengths": ["优势"],
    "risks": ["风险"],
    "suggestions": ["建议"]
  },
  "weeklyPlan": [{
    "dayIndex": 1-7,
    "dayName": "周一/周二...",
    "date": "YYYY-MM-DD",
    "type": "轻松跑/节奏跑/间歇/LSD/休息",
    "totalDistance": 公里数,
    "paceZone": "配速区间",
    "hrZone": "心率区间",
    "description": "训练说明",
    "详细计划": {"warmup": "...", "main": "...", "cooldown": "...", "notes": "..."}
  }],
  "coachAdvice": "教练综合建议"
}`;

      const contextJson = JSON.stringify(context);
      console.log(`  Context size: ${(contextJson.length / 1024).toFixed(0)} KB`);
      analysisResult = await llm.chatJSON(systemPrompt, context);
      if (analysisResult) {
        console.log("LLM analysis complete.");
        saveAnalysisJSON(dateFile, context, analysisResult);
      } else {
        console.log("  LLM returned non-JSON response. Checking raw output...");
        // Try again without jsonMode, get raw text
        const raw = await llm.chat(systemPrompt, contextJson);
        if (raw) {
          console.log(`  Raw response (first 200 chars): ${raw.slice(0, 200)}`);
        } else {
          console.log("  LLM returned no content at all.");
        }
      }
    } catch (e) {
      console.log(`LLM analysis failed: ${e.message}, falling back to rule-engine markdown.`);
    }
  } else {
    console.log("No LLM configuration found, generating rule-engine markdown.");
  }

  // Step 3: Always output markdown report
  const mdReport = generateMarkdownReport(data);
  console.log("\n" + mdReport);
}

main().catch((e) => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
