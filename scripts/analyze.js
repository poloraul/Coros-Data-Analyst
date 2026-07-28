#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLLM } from "../lib/llm.js";
import { MARATHON_DATE, MARATHON_TARGET_PACE, MARATHON_TARGET_TIME, PHASES, LACTATE_THRESHOLD_HR, RUNNING_SPORT_TYPES } from "../lib/training-constants.js";
import { paceToSeconds, secondsToPace, getAge, weeksUntilMarathon, getCurrentPhase, getCurrentWeekBounds } from "../lib/training-utils.js";
import { calcPaceZones, calcHRZones } from "../lib/zones.js";
import { calcWkg, estimateFTP, classifyPowerZone, calcPowerZones, POWER_ZONE_DEFS } from "../lib/power-utils.js";
import { getHolidayAnnotations, getHolidaysInRange } from "../lib/holidays.js";
import { PHASE_TEMPLATES } from "../lib/training-templates.js";

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

const isRunning = r => RUNNING_SPORT_TYPES.includes(r.sportType);

function weeklyReview(data) {
  const { start, end } = getCurrentWeekBounds();
  const records = (data.sportRecords || []).filter(r => r.date >= start && r.date <= end && isRunning(r));
  const details = (data.activityDetails || []).filter(d => d.date >= start && d.date <= end && isRunning(d));
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
  const templates = PHASE_TEMPLATES;

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

  // Individual workout reviews（仅跑步）
  const workoutReviews = (data.activityDetails || []).filter(isRunning).map(d => reviewWorkout(d, tp, maxHR)).filter(Boolean).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

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

function summarizeTcxMetrics(metrics, avgStrideLength, totalDistance) {
  if (!metrics) return null;
  const parts = [];
  const allSplits = metrics.kmSplits || [];
  // 按实际 API 距离截断 km splits，防止 GPS 漂移导致超过实际距离的分段被计入
  const maxKm = totalDistance > 0 ? Math.ceil(totalDistance) : Infinity;
  const splits = totalDistance > 0 ? allSplits.filter(s => s.km <= maxKm) : allSplits;

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

  // Pace drift (midpoint-based)
  if (metrics.paceDrift) {
    parts.push(`配速漂移${metrics.paceDrift.firstHalfPace}→${metrics.paceDrift.secondHalfPace}(${metrics.paceDrift.driftPct}%)`);
  }

  // Max HR from FIT session
  if (metrics.maxHR) {
    parts.push(`HRmax${metrics.maxHR}`);
  }

  // Lap summary
  if (metrics.lapSummaries && metrics.lapSummaries.length > 1) {
    const maxHRLaps = metrics.lapSummaries.filter(l => l.maxHR).length;
    parts.push(`${metrics.lapSummaries.length}圈${maxHRLaps > 0 ? `(HR峰值${maxHRLaps}圈)` : ""}`);
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

  // Cadence (now includes mid-range 170-180%)
  if (metrics.cadence) {
    const cadStr = `步频${metrics.cadence.avgCadence}`;
    const midStr = metrics.cadence.pct170to180 != null ? `(170-180:${metrics.cadence.pct170to180}% >180:${metrics.cadence.pctAbove180}%)` : `(>180:${metrics.cadence.pctAbove180}%)`;
    parts.push(cadStr + midStr);
  }

  // Elevation (enhanced with net and avg)
  if (metrics.elevation && metrics.elevation.totalGain > 20) {
    let elevStr = `爬升+${metrics.elevation.totalGain}m`;
    if (metrics.elevation.net != null) {
      elevStr += `净${metrics.elevation.net > 0 ? "+" : ""}${metrics.elevation.net}m`;
    }
    if (metrics.elevation.avgAlt) {
      elevStr += `均${metrics.elevation.avgAlt}m`;
    }
    parts.push(elevStr);
  }

  // Average temperature (if available from FIT wrist sensor)
  if (metrics.avgTemp != null) {
    parts.push(`腕温${metrics.avgTemp}°C`);
  }

  // Running economy: stride length × cadence (from MCP data)
  if (avgStrideLength && metrics.cadence?.avgCadence) {
    const speedMps = avgStrideLength * metrics.cadence.avgCadence / 60; // m/s
    const ecoLabel = speedMps >= 4.5 ? "经济性好" : speedMps >= 3.5 ? "经济性中等" : "经济性偏低";
    parts.push(`步幅${avgStrideLength.toFixed(2)}m×步频${metrics.cadence.avgCadence}=${speedMps.toFixed(1)}m/s(${ecoLabel})`);
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
 * Compress pace/hrzones for LLM context — strip UI-only fields (color, short).
 * Saves ~800 bytes (~200 tokens) per LLM call.
 */
function compressZones(zones) {
  return (zones || []).map(z => ({
    key: z.key,
    name: z.name,
    range: z.range || z.hrRange,
  }));
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

  // Weekly summary inline (filtered by current week 周一→周日，仅跑步)
  const wRecs = records.filter(r => r.date >= wS && r.date <= wE && isRunning(r));
  const wDetails = (data.activityDetails || []).filter(d => d.date >= wS && d.date <= wE && isRunning(d));
  const totalKm = wRecs.reduce((s, r) => s + (r.distance || 0), 0);
  const totalTL = wDetails.reduce((s, d) => s + (d.trainingLoad || 0), 0);
  const runCount = wRecs.filter((r) => r.sportType === 100 || r.sportType === 101).length;

  // Build workouts with TCX summaries（仅跑步）
  const workouts = (data.activityDetails || []).filter(isRunning).map((d) => ({
    date: d.date,
    distance: d.distance,
    duration: d.workoutTime,
    avgPace: d.avgPace,
    bestKm: d.bestKm,
    avgHR: d.avgHR,
    avgCadence: d.avgCadence,
    avgStrideLength: d.avgStrideLength,
    trainingLoad: d.trainingLoad,
    performance: d.performance,
    avgPower: d.avgPower || null,
    tcxSummary: summarizeTcxMetrics(d.tcxMetrics, d.avgStrideLength, d.distance),
    kmSplitSummary: d.tcxMetrics?.kmSplits
      ? (() => {
          const maxKm = Math.ceil(d.distance || 0);
          const valid = d.tcxMetrics.kmSplits
            // 过滤 GPS 噪声：3:50/km~15:00/km 为合理跑步/冷身范围（阈值配速4:18，Z6起点3:50），排除无效 paceStr
            .filter((s) => s.paceSecPerKm >= 230 && s.paceSecPerKm <= 900 && s.paceStr && s.paceStr !== "-")
            // 按实际 API 距离截断，防止 GPS 漂移导致超过实际距离的分段被 LLM 误用
            .filter((s) => maxKm > 0 ? s.km <= maxKm : true)
            .map((s) => `KM${s.km}=${s.paceStr}(HR${s.avgHR})`);
          return valid.length >= 2 ? valid.join(" ") : null;
        })()
      : null,
    weather: d.weather || null,
  }));

  // Enrich each workout with derived power metrics
  for (const w of workouts) {
    w.powerWkg = calcWkg(w.avgPower, user.weight);
  }

  // Estimate FTP from recent running history (sportType=100 only, distance >= 5km)
  const runningHistory = (data.activityDetails || [])
    .filter(d => d.sportType === 100 && d.avgPower > 0 && (d.distance || 0) >= 5)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map(d => ({ date: d.date, distance: d.distance, avgPower: d.avgPower }));
  const ftp = estimateFTP(runningHistory, user.weight);
  // Annotate each workout's powerZone
  for (const w of workouts) {
    if (w.avgPower && ftp.ftpW) {
      w.powerZone = POWER_ZONE_DEFS[classifyPowerZone(w.avgPower, ftp.ftpW)].key;
    } else {
      w.powerZone = null;
    }
  }

  return {
    profile: {
      age: getAge(user.birthday),
      height: user.height,
      weight: user.weight,
      vo2max: fitness.vo2max,
      thresholdPace: fitness.thresholdPace,
      maxHR,
      ftpW: ftp.ftpW,
      ftpWkg: ftp.ftpWkg,
      ftpSampleSize: ftp.sampleSize,
      ftpConfidence: ftp.confidence,
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
    paceZones: compressZones(calcPaceZones(fitness.thresholdPace)?.zones),
    hrZones: compressZones(calcHRZones(LACTATE_THRESHOLD_HR, { useLTHR: true })?.zones),
    powerZones: ftp.ftpW ? compressZones(calcPowerZones(ftp.ftpW)) : null,
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
    holidays: {
      thisWeek: getHolidayAnnotations([...Array(7).keys()].map(i => {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        return d.toISOString().slice(0, 10);
      })),
      upcomingNext4Weeks: (() => {
        const fourWeeksLater = new Date(now);
        fourWeeksLater.setDate(fourWeeksLater.getDate() + 28);
        return getHolidaysInRange(now.toISOString().slice(0, 10), fourWeeksLater.toISOString().slice(0, 10));
      })(),
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

// --- System Prompt Builder ---

const TRAINING_RULES = `
优先级覆盖（最高优先，命中即锁定，忽略其他规则）：
1. 若任意连续快速段（≤4:30/km）与慢速段（≥6:30/km）交替出现 ≥2 组 → 强制锁定"间歇跑"
2. 若全程配速 CV>8% 且无上述快慢交替模式 → 强制判为"法特莱克/变速跑"

训练阶段识别（按心率拐点+比例混合切割）：
- 热身段：起跑至心率首次稳定进入目标区间的拐点；若拐点前距离>总里程25% → 标记"热身过长"
- 主训练段：心率稳定在目标区间的连续段落（剔除GPS异常公里）
- 冷身段：配速主动下降且心率下降>10bpm的末段
- 若总里程≤6km，热身+冷身总占比不得超过40%，否则结构质量判为"fair"
- 崩盘辨析：心率随配速下降=主动冷身；心率维持高位（Z3+）=体能衰竭
- 无显著分段：配速全程均匀→标记"全程稳态"
- 异常公里：配速<3:30或>10:00/km（非冷身段）→GPS噪声，不作为判断依据

训练模式（基于kmSplitSummary + tcxSummary）：
| 模式 | 特征 | CV | 备注 |
|------|------|----|------|
| 轻松跑 | Z1-Z2为主，漂移<8% | <6% | 配速均匀 |
| 节奏跑 | Z3区域，稳定20-40min | <5% | |
| 阈值跑 | Z4区间，后程可小幅掉速 | <5% | 整体稳定 |
| 间歇跑 | 快慢交替，快速段Z4-Z6(≤4:30) ±5s，慢速段≥6:30恢复 | — | 即使GPS公里不连续/心率偏低，仍判为间歇跑 |
| LSD | 距离≥15km，Z2-Z3 | — | 漂移>5%正常 |
| 混合训练 | 负分段/多强度段落，无重复模式 | — | 有快慢重复→优先判间歇 |
| 法特莱克 | 不规则速度波动，非固定周期 | — | 快速段变化较大 |

特殊规则：
- 间歇跑重点看快速段配速（而非全局均值），热身/冷身/恢复段会拉低均值
- 光学心率滞后5-10s：快速段心率显示偏低是短间歇特征，非GPS漂移证据
- 快速段(≤4:30) + 慢速段(≥6:30)同时出现，先怀疑间歇跑

生物力学红线（触发即输出到improvements首条）：
- 若步频<170spm（且配速>5:30/km）→ 下次轻松跑使用节拍器强制178bpm，缩小步幅5cm

跑步经济性分析（基于avgStrideLength + cadence）：
- 经济速度(m/s) = 步幅(m) × 步频(spm) / 60
- 目标参考：配速5:00/km时步幅1.1-1.2m×步频180spm=3.3m/s；配速4:30/km时步幅1.2-1.3m×步频180spm=3.6-3.9m/s
- 若经济速度偏低但步频达标→步幅不足，建议增加髂腰肌力量和跨步训练
- 若经济速度偏低且步频也低→整体跑经济性差，需同时提升核心力量和步频意识
- 若后程配速下降时步频不变但步幅缩短→髋屈肌疲劳，建议加强臀中肌和屈髋肌训练

跑步功率分析原则（仅当数据包含 avgPower 时适用）：
1. 跑步 avgPower 反映"在 X 配速区间维持的机械功率输出"——单值整数瓦特数
2. W/kg 分级参考：> 3.0 业余精英级；2.5-3.0 高级跑者；2.0-2.5 中级；< 2.0 初阶
3. 同一跑者"相同配速下功率越低"= 跑步经济性越好（效率提升）
4. 间歇训练参考：Z4-Z5 重复段平均功率应稳定在 90-115% FTP 区间
5. 当 ftpConfidence 为 "low" 或 "none" 时，功率解读应保守，**只描述观察**不给出功率区间建议
6. powerZone 字段（Z1-Z6）已基于估算 FTP 自动标注，可直接引用`;

function buildSystemPrompt(context, { incremental = false } = {}) {
  const zoneInfo = context.paceZones && context.hrZones
    ? `你的乳酸阈心率${context.hrZones[3]?.range || "163-173bpm"}。训练区间见paceZones/hrZones数据。`
    : "";

  if (incremental) {
    // 增量模式：仅分析新增训练，不生成全局字段
    return `你是资深跑步教练（CSCS认证），专精马拉松训练和运动生理学。

分析原则：
1. 数据驱动：基于tcxSummary和kmSplitSummary做量化分析
2. 目标导向：以首马3:30（配速4:58/km）为基准
3. 具体可执行：改进建议必须给出具体配速/心率/步频数值
4. 环境校正（解读心率时）：温度>22°C每升高1°C预期心率+1.5-2bpm；湿度>70%时系数翻倍
5. 配速统一：所有配速值、经济速度**必须**使用 min/km 格式（如"4:58/km"），禁止 m/s

${TRAINING_RULES}

请只输出workoutReviews数组，不需要bodyAssessment/trainingPatternAnalysis/weeklyPlan/coachAdvice。

输出严格JSON：
{ "workoutReviews": [{
    "date": "YYYY-MM-DD",
    "trainingType": "轻松跑/节奏跑/间歇跑/阈值跑/LSD/混合训练/法特莱克",
    "phaseBreakdown": { "warmup":"...", "main":"...", "cooldown":"...", "structureQuality":"excellent/good/fair/poor" },
    "summary": "...",
    "detailedAnalysis": "技术分析（100-200字）：引用kmSplitSummary和tcxSummary数据，分析配速趋势、心率漂移、区间分布、天气影响",
    "positives": ["具体亮点（带数据支撑）"],
    "improvements": ["改进建议（含具体配速/心率/步频数值）"]
  }]
}`;
  }

  // 全量模式：完整分析
  return `你是资深跑步教练（CSCS认证），专精马拉松训练和运动生理学。

分析原则：
1. 数据驱动：基于tcxSummary的配速趋势、心率漂移、区间分布、步频数据做量化分析
2. 目标导向：以首马3:30（配速4:58/km）为基准评价训练方向
3. 具体可执行：改进建议必须给出具体配速范围、心率目标或步频要求
4. 配速统一：所有配速值、经济速度、速度相关指标**必须**使用 min/km 格式（如"4:58/km"），禁止使用 m/s 或其他单位
5. 环境因素：结合天气数据分析对训练表现的影响
6. 环境校正（解读心率时必须代入）：温度>22°C时每升高1°C预期心率增加1.5-2bpm；湿度>70%时系数翻倍；若本次温度较上次同类型升高≥5°C，心率上升≤8bpm不视为负面指标

${TRAINING_RULES}

训练哲学：二区训练+两极化训练（约80% Z1-Z2低强度、20% Z4-Z6高强度，最小化Z3灰色区）。${zoneInfo}

训练安排偏好（两极化原则）：
- **高质量课（Z4+）**：每周1-2次，周三/四。间歇跑(Z5-Z6)/阈值跑(Z4)/节奏跑(Z3-Z4)
- **LSD**（Z2为主）：周六/日，15-22km
- **轻松跑**（Z2）：其他训练日，配速比马配慢30-60s
- **主动恢复**（Z1）：非训练日30-40min慢跑/散步
- 节假日（见holidays数据）可安排高质量课或LSD

周计划规则：
1. weeklyPlan必须从报告日期（${context.today.date} ${context.today.dayOfWeek}）开始，按时间顺序连续7天，dayIndex=1对应报告日当天，dayIndex=7对应第7天；不要从"本周一"或"本周六"开始
2. weeklyPlan[].date必须是 dayIndex 对应的实际日期（YYYY-MM-DD）
3. 周跑量目标45-60km
4. 示例排课：周一轻松跑→周二轻松跑→周三质量课→周四轻松跑/休息→周五轻松跑→周六LSD→周日休息/恢复

输出严格JSON，必含字段：
workoutReviews[].{date,trainingType,phaseBreakdown:{warmup,main,cooldown,structureQuality},summary,detailedAnalysis,positives[],improvements[]}
bodyAssessment.{overallLevel,summary,details[],recommendations[]}
trainingPatternAnalysis.{summary,strengths[],risks[],suggestions[]}
weeklyPlan[].{dayIndex,dayName,date,type,totalDistance,paceZone,hrZone,description,详细计划:{warmup,main,cooldown,notes},workoutSteps[]}
coachAdvice

字段说明：
- trainingType: 轻松跑/节奏跑/间歇跑/阈值跑/LSD/混合训练/法特莱克
- structureQuality: excellent/good/fair/poor
- detailedAnalysis: 100-200字技术分析
- weeklyPlan[].type: 轻松跑/节奏跑/间歇/LSD/休息
- weeklyPlan[].totalDistance: 数字（km 单位，无"km"后缀）；休息日=0
- weeklyPlan[].workoutSteps: 必填字段，结构化步骤数组，用于COROS手表推送。每个非休息日都必须有 workoutSteps。每步格式：
  - 热身/主训/冷身: {"kind":"warmup/training/cooldown", "targetDistanceKm":数字, "pace":"X:XX-X:XX/km"}
  - 间歇组: {"repeat":组数, "steps":[{"kind":"interval","targetDistanceKm":0.4,"pace":"X:XX-X:XX/km"},{"kind":"rest","targetDurationSeconds":120}]}
  - 纯休息: {"kind":"rest","targetDurationSeconds":数字}
  重要：距离和配速必须与详细计划中的热身/主训/冷身一致！
- overallLevel: green/yellow/red`;
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
    console.error("STATUS:ERROR:data file not found");
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
          return;
        }
        // Incremental mode: only analyze new activities, merge with existing
        const existingAnalysis = existing;
        const newDates = currentLabelIds.filter(d => !existingLabelIds.includes(d));
        const knownDates = currentLabelIds.filter(d => existingLabelIds.includes(d));
        console.log(`  New activities: ${newDates.length}, existing: ${knownDates.length}`);
        if (newDates.length > 0 && knownDates.length > 0) {
          try {
            console.log("  Incremental mode: analyzing new activities only...");
            // Build incremental context with only new workouts
            const incrementalContext = JSON.parse(JSON.stringify(context));
            incrementalContext.workouts = context.workouts.filter(w => newDates.includes(w.date));
            // Recalculate weekly summary for new activities only
            const newWorkoutDetails = (data.activityDetails || []).filter(d => newDates.includes(d.date));
            incrementalContext.weeklySummary = {
              totalKm: Math.round(newWorkoutDetails.reduce((s, d) => s + (d.distance || 0), 0) * 10) / 10,
              runCount: newWorkoutDetails.length,
              totalTL: Math.round(newWorkoutDetails.reduce((s, d) => s + (d.trainingLoad || 0), 0)),
            };

            const llm = createLLM(llmConfig);
            const incSysPrompt = buildSystemPrompt(context, { incremental: true });

            const newReviews = await llm.chatJSON(incSysPrompt, incrementalContext);
            if (newReviews && newReviews.workoutReviews && newReviews.workoutReviews.length > 0) {
              // Only proceed with incremental merge if existing analysis has global sections
              const hasGlobals = existingAnalysis.analysis?.bodyAssessment
                && existingAnalysis.analysis?.trainingPatternAnalysis
                && existingAnalysis.analysis?.weeklyPlan;
              if (!hasGlobals) {
                console.log("  Existing analysis lacks global sections, triggering full analysis...");
                // Don't return — fall through to full analysis below
              } else {
                // Merge: keep existing reviews for unchanged dates, append/prepend new ones
                const existingReviews = existingAnalysis.analysis?.workoutReviews || [];
                const mergedReviews = [
                  ...newReviews.workoutReviews,
                  ...existingReviews.filter(r => !newDates.includes(r.date)),
                ];
                const mergedAnalysis = {
                  workoutReviews: mergedReviews,
                  bodyAssessment: existingAnalysis.analysis.bodyAssessment,
                  trainingPatternAnalysis: existingAnalysis.analysis.trainingPatternAnalysis,
                  weeklyPlan: existingAnalysis.analysis.weeklyPlan,
                  coachAdvice: existingAnalysis.analysis.coachAdvice || null,
                };
                console.log(`  Incremental analysis complete: ${newReviews.workoutReviews.length} reviews added.`);
                saveAnalysisJSON(dateFile, context, mergedAnalysis);
                return;
              }
            } else {
              console.log("  Incremental analysis returned no results, falling back to full analysis...");
            }
          } catch (e) {
            console.log(`  Incremental analysis failed (${e.message}), falling back to full analysis...`);
          }
        }
        console.log("  Full re-analysis (all activities)...");
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
      const systemPrompt = buildSystemPrompt(context);

      const contextJson = JSON.stringify(context);
      console.log(`  Context size: ${(contextJson.length / 1024).toFixed(0)} KB`);
      // Required top-level fields for a complete analysis. If any are missing,
      // retry — LLM responses are sometimes incomplete.
      const REQUIRED_FIELDS = ["workoutReviews", "bodyAssessment", "trainingPatternAnalysis", "weeklyPlan", "coachAdvice"];
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        analysisResult = await llm.chatJSON(systemPrompt, context);
        if (analysisResult) {
          const missing = REQUIRED_FIELDS.filter(k => !analysisResult[k]);
          if (missing.length === 0) {
            console.log(`  LLM returned all ${REQUIRED_FIELDS.length} fields (attempt ${attempt})`);
            break;
          }
          console.log(`  Attempt ${attempt}: missing fields [${missing.join(", ")}], retrying...`);
          if (attempt === MAX_ATTEMPTS) {
            // Save what we have; downstream code uses || fallbacks
            console.log(`  Giving up on missing fields after ${MAX_ATTEMPTS} attempts`);
            break;
          }
          // Reset to retry
          analysisResult = null;
        } else {
          break; // non-JSON, fall through to raw handling below
        }
      }
      if (analysisResult) {
        console.log("LLM analysis complete.");
        saveAnalysisJSON(dateFile, context, analysisResult);
      } else {
        console.log("  LLM returned non-JSON response. Checking raw output...");
        // Try fallback call, get raw text
        const raw = await llm.chat(systemPrompt, contextJson);
        if (raw) {
          console.log(`  Raw response length: ${raw.length} chars`);
          console.log(`  Raw response first 200: ${raw.slice(0, 200)}`);
          // Try to parse raw text as JSON — handle invisible chars, BOM, markdown fence
          let clean = raw.trim();
          // Remove BOM / zero-width chars
          clean = clean.replace(/^[﻿​‌‍]+/, "");
          // Remove markdown code fence
          clean = clean.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          // Try direct parse
          let parsed = null;
          try { parsed = JSON.parse(clean); } catch {}
          if (!parsed) {
            const first = clean.indexOf("{");
            const last = clean.lastIndexOf("}");
            if (first !== -1 && last > first) {
              try { parsed = JSON.parse(clean.slice(first, last + 1)); } catch {}
            }
          }
          if (parsed && parsed.workoutReviews) {
            analysisResult = parsed;
            console.log("  Parsed JSON from fallback response.");
            saveAnalysisJSON(dateFile, context, analysisResult);
          } else {
            // Last resort: use jsonrepair for robust JSON fixing
            try {
              const { jsonrepair } = await import("jsonrepair");
              const f3 = clean.indexOf("{");
              const l3 = clean.lastIndexOf("}");
              if (f3 !== -1 && l3 > f3) {
                parsed = JSON.parse(jsonrepair(clean.slice(f3, l3 + 1)));
              }
            } catch (e) {
              console.log(`  JSON repair failed: ${e.message.slice(0, 120)}`);
            }
            if (parsed && parsed.workoutReviews) {
              analysisResult = parsed;
              console.log("  Parsed JSON (repaired).");
              saveAnalysisJSON(dateFile, context, analysisResult);
            } else {
              console.log("  Could not parse JSON from fallback response.");
            }
          }
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
}

main().then(() => {
  console.log("STATUS:OK");
  process.exit(0);
}).catch((e) => {
  console.error(`STATUS:ERROR:${e.message}`);
  process.exit(1);
});
