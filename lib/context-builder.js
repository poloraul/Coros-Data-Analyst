import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getTcxEnrichedAnalysis, computePerKmHrTrend } from "./tcx-utils.js";
import { computeAerobicDecoupling, computePaceVariability, computeRunningEfficiencyIndex, computeHrRecoveryRate } from "./tcx-advanced.js";

const MARATHON_DATE = new Date(2026, 11, 6);
const MARATHON_TARGET_PACE = "4:58";
const MARATHON_TARGET_TIME = "3:30:00";
const PHASES = [
  { name: "基础期 I", startWeek: 1, endWeek: 8, weeklyKm: [50, 65], focus: "有氧耐力、建立跑量" },
  { name: "基础期 II", startWeek: 9, endWeek: 16, weeklyKm: [65, 80], focus: "节奏跑引入、MLD" },
  { name: "强化期", startWeek: 17, endWeek: 20, weeklyKm: [75, 90], focus: "间歇、阈值、MP配速" },
  { name: "巅峰期", startWeek: 21, endWeek: 22, weeklyKm: [80, 85], focus: "最长LSD、MP实战" },
  { name: "减量期", startWeek: 23, endWeek: 24, weeklyKm: [50, 30], focus: "减量保状态" },
];

function getAge(birthday) {
  const today = new Date();
  const birth = new Date(birthday);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

function weeksUntilMarathon() {
  return Math.max(0, Math.ceil((MARATHON_DATE - new Date()) / (7 * 86400000)));
}

function getCurrentPhase(weeksLeft) {
  if (weeksLeft > 24) return { name: "准备期", weeklyKm: [45, 60], currentWeek: 0, focus: "建立基础跑量、维持有氧" };
  const weekNum = 24 - weeksLeft + 1;
  for (const phase of PHASES) {
    if (weekNum >= phase.startWeek && weekNum <= phase.endWeek) return { ...phase, currentWeek: weekNum };
  }
  return { ...PHASES[PHASES.length - 1], currentWeek: weekNum };
}

function enrichWorkoutWithTcx(detail, projectRoot) {
  const tcxRelPath = detail.tcxPath;
  if (!tcxRelPath) return null;

  const fullPath = path.join(projectRoot, tcxRelPath);
  if (!existsSync(fullPath)) return null;

  try {
    const content = readFileSync(fullPath, "utf-8");
    const analysis = getTcxEnrichedAnalysis(content);
    if (!analysis) return null;

    const tps = analysis.allTrackpoints;
    return {
      splits: analysis.splits,
      paceDrift: analysis.paceDrift,
      hrZones: analysis.hrZones,
      cadenceStats: analysis.cadenceStats,
      elevationStats: analysis.elevationStats,
      perKmHrTrend: computePerKmHrTrend(analysis.splits),
      aerobicDecoupling: computeAerobicDecoupling(tps),
      paceVariability: computePaceVariability(analysis.splits),
      runningEfficiency: computeRunningEfficiencyIndex(tps),
      hrRecoveryRate: computeHrRecoveryRate(tps),
    };
  } catch {
    return null;
  }
}

export function buildAnalysisContext(dailyData, projectRoot) {
  const user = dailyData.userInfo || {};
  const fitness = dailyData.fitness || {};
  const maxHR = 220 - getAge(user.birthday || "1990-01-01");
  const tp = fitness.thresholdPace || "4:37";
  const weeksLeft = weeksUntilMarathon();
  const phase = getCurrentPhase(weeksLeft);

  // Profile
  const profile = {
    age: getAge(user.birthday),
    height: user.height,
    weight: user.weight,
    gender: user.gender,
    birthday: user.birthday,
    vo2max: fitness.vo2max,
    thresholdPace: tp,
    maxHR,
    racePredictions: {
      "5k": fitness.pred5k,
      "10k": fitness.pred10k,
      halfMarathon: fitness.predHalfMarathon,
      marathon: fitness.predMarathon,
    },
  };

  // Goal
  const goal = {
    targetTime: MARATHON_TARGET_TIME,
    targetPace: MARATHON_TARGET_PACE,
    marathonDate: MARATHON_DATE.toISOString().slice(0, 10),
    weeksLeft,
    currentPhase: phase.name,
    currentWeek: phase.currentWeek,
    phaseFocus: phase.focus,
    targetWeeklyKm: phase.weeklyKm,
  };

  // Body status
  const hrvDays = dailyData.hrv?.days || [];
  const normalLow = dailyData.hrv?.normalRange?.[0] || 50;
  let consecutiveBelow = 0;
  for (const day of hrvDays) { if (day.hrv < normalLow) consecutiveBelow++; else break; }

  const recovery = dailyData.recovery;
  const latestSleep = dailyData.sleep?.[0] || dailyData.dailyHealth?.[dailyData.dailyHealth.length - 1];
  const deepSleepPct = latestSleep?.deepRatio ?? null;

  const bodyStatus = {
    recovery: {
      percentage: recovery?.percentage,
      level: recovery?.level,
      estimatedFullRecovery: recovery?.estimatedFullRecovery,
    },
    hrv: {
      baseline: dailyData.hrv?.baseline,
      normalRange: dailyData.hrv?.normalRange,
      latestValue: hrvDays[0]?.hrv,
      latestEval: hrvDays[0]?.evaluation,
      trend7d: hrvDays.slice(0, 7).map(d => ({ date: d.date, hrv: d.hrv, eval: d.evaluation })),
      consecutiveBelow,
    },
    sleep: {
      latestScore: latestSleep?.sleepScore,
      deepRatio: deepSleepPct,
      trend7d: (dailyData.sleep || []).slice(0, 7).map(s => ({
        date: s.date?.slice?.(0, 10) || s.date,
        score: s.sleepScore,
        deepRatio: s.deepRatio,
      })),
    },
    stress: {
      avg7d: dailyData.dailyHealth?.slice(0, 7).reduce((s, d) => s + (d.avgStress || 0), 0) / Math.max(1, Math.min(7, dailyData.dailyHealth?.length || 0)),
      trend: dailyData.dailyHealth?.slice(0, 7).map(d => ({ date: d.date, stress: d.avgStress })),
    },
    trainingLoad: {
      shortTerm: dailyData.trainingLoad?.[0]?.shortTermLoad,
      longTerm: dailyData.trainingLoad?.[0]?.longTermLoad,
      ratio: dailyData.trainingLoad?.[0]?.loadRatio,
      comment: dailyData.trainingLoad?.[0]?.comment,
    },
  };

  // Workouts with TCX enrichment
  const details = dailyData.activityDetails || [];
  const workouts = details.map(d => {
    const tcxEnrichment = enrichWorkoutWithTcx(d, projectRoot);
    return {
      date: d.date,
      distance: d.distance,
      duration: d.workoutTime,
      avgPace: d.avgPace,
      movingAvgPace: d.movingAvgPace,
      adjustedPace: d.adjustedPace,
      bestKm: d.bestKm,
      avgHR: d.avgHR,
      avgCadence: d.avgCadence,
      avgStrideLength: d.avgStrideLength,
      elevationGain: d.elevationGain,
      elevationLoss: d.elevationLoss,
      calories: d.calories,
      trainingLoad: d.trainingLoad,
      performance: d.performance,
      // TCX enrichment
      ...(tcxEnrichment || {}),
    };
  });

  // Weekly summary
  const records = dailyData.sportRecords || [];
  const totalKm = records.reduce((s, r) => s + (r.distance || 0), 0);
  const totalTL = details.reduce((s, d) => s + (d.trainingLoad || 0), 0);
  const runCount = records.filter(r => r.sportType === 100 || r.sportType === 101).length;

  const tpSeconds = paceToSeconds(tp);
  let easy = 0, moderate = 0, hard = 0;
  for (const d of details) {
    const ap = paceToSeconds(d.avgPace);
    if (!ap || !tpSeconds) continue;
    const ratio = ap / tpSeconds;
    if (ratio > 1.08) easy += d.distance || 0;
    else if (ratio > 0.97) moderate += d.distance || 0;
    else hard += d.distance || 0;
  }

  const weeklySummary = {
    totalKm: Math.round(totalKm * 10) / 10,
    runCount,
    totalTL,
    intensityDistribution: { easyKm: Math.round(easy * 10) / 10, moderateKm: Math.round(moderate * 10) / 10, hardKm: Math.round(hard * 10) / 10 },
    loadRatio: dailyData.trainingLoad?.[0]?.loadRatio,
    shortTermLoad: dailyData.trainingLoad?.[0]?.shortTermLoad,
    longTermLoad: dailyData.trainingLoad?.[0]?.longTermLoad,
  };

  return { profile, goal, bodyStatus, workouts, weeklySummary };
}

function paceToSeconds(pace) {
  if (!pace) return 0;
  const parts = pace.split(":");
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}
