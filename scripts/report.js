#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARATHON_DATE, PHASES } from "../lib/training-constants.js";
import { paceToSeconds, secondsToPace, getAge, weeksUntilMarathon, getCurrentPhase, getCurrentWeekBounds } from "../lib/training-utils.js";
import { parseTCX } from "./tcx-analyzer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");
const REPORT_DIR = path.join(PROJECT_ROOT, "reports");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { date: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) parsed.date = args[++i];
  }
  return parsed;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// --- Rule-engine analysis (fallback when no AI analysis available) ---

function assessRecovery(data) {
  const hrvDays = data.hrv?.days || [];
  const normalLow = data.hrv?.normalRange?.[0] || 50;
  const recovery = data.recovery;
  let consecutiveBelow = 0;
  for (const day of hrvDays) { if (day.hrv < normalLow) consecutiveBelow++; else break; }
  let level = "green";
  const reasons = [];
  if (consecutiveBelow >= 3) { level = "red"; reasons.push(`HRV连续${consecutiveBelow}天低于正常范围`); }
  else if (consecutiveBelow >= 2) { level = "yellow"; reasons.push(`HRV连续${consecutiveBelow}天低于正常范围`); }
  if (recovery?.percentage && recovery.percentage < 70) { level = "red"; reasons.push(`恢复度仅${recovery.percentage}%`); }
  else if (recovery?.percentage && recovery.percentage < 85 && level === "green") { level = "yellow"; reasons.push(`恢复度${recovery.percentage}%偏低`); }
  return { level, reasons, recoveryPct: recovery?.percentage, latestHRV: hrvDays[0]?.hrv, consecutiveBelow, baseline: data.hrv?.baseline, normalRange: data.hrv?.normalRange };
}

function reviewLatestWorkout(activity, thresholdPace, maxHR) {
  if (!activity) return null;
  const tp = paceToSeconds(thresholdPace);
  const ap = paceToSeconds(activity.avgPace);
  const bp = paceToSeconds(activity.bestKm);
  const paceRatio = tp > 0 ? ap / tp : 0;
  const hrPct = maxHR > 0 ? (activity.avgHR / maxHR) * 100 : 0;

  let intensityZone = "未知";
  let zoneColor = "#7cb9e8";
  if (paceRatio > 1.15) { intensityZone = "轻松跑 (E区)"; zoneColor = "#7ec882"; }
  else if (paceRatio > 1.05) { intensityZone = "有氧耐力 (E-M区)"; zoneColor = "#4db8a4"; }
  else if (paceRatio > 0.98) { intensityZone = "节奏跑 (T区)"; zoneColor = "#f4c542"; }
  else if (paceRatio > 0.92) { intensityZone = "阈值跑 (T-I区)"; zoneColor = "#e89898"; }
  else { intensityZone = "间歇区 (I区)"; zoneColor = "#c07070"; }

  const cadenceGap = activity.avgCadence ? Math.max(0, 180 - activity.avgCadence) : null;

  const findings = [];
  const positives = [];
  const improvements = [];

  if (paceRatio > 1.05 && paceRatio <= 1.15) {
    findings.push(`配速 ${activity.avgPace}/km，为阈值配速的 ${(paceRatio * 100).toFixed(0)}%，处于中高强度有氧区间`);
    if (bp && ap - bp < 20) positives.push("配速控制稳定，最快/平均公里差仅" + secondsToPace(ap - bp));
    else if (bp) improvements.push(`配速波动较大（最快${secondsToPace(bp)}vs平均${activity.avgPace}），建议关注匀速跑能力`);
  } else if (paceRatio > 1.15) {
    findings.push(`配速 ${activity.avgPace}/km，轻松跑强度（${(paceRatio * 100).toFixed(0)}%阈值），有氧基础训练`);
  } else {
    findings.push(`配速 ${activity.avgPace}/km，接近或达到阈值强度（${(paceRatio * 100).toFixed(0)}%阈值），高强度训练`);
  }

  findings.push(`平均心率 ${activity.avgHR}bpm（${Math.round(hrPct)}% HRmax）`);
  if (hrPct > 85) improvements.push("心率偏高，注意控制强度避免过度训练");
  else positives.push("心率区间合理");

  if (cadenceGap && cadenceGap > 5) improvements.push(`步频${activity.avgCadence}spm偏低，建议提升至180+spm（差${cadenceGap}spm）`);
  else if (activity.avgCadence >= 180) positives.push(`步频${activity.avgCadence}spm达标`);

  if (activity.trainingLoad > 150) findings.push(`训练负荷 ${activity.trainingLoad}TL，属于高负荷训练`);
  else findings.push(`训练负荷 ${activity.trainingLoad}TL`);

  return { activity, intensityZone, zoneColor, paceRatio, hrPct, cadenceGap, findings, positives, improvements };
}

function generateRuleBasedPlan(data, recovery) {
  const weeksLeft = weeksUntilMarathon();
  const phase = getCurrentPhase(weeksLeft);
  const { start, end } = getCurrentWeekBounds();
  const records = (data.sportRecords || []).filter(r => r.date >= start && r.date <= end);
  const recoveryMultiplier = recovery.level === "red" ? 0.6 : recovery.level === "yellow" ? 0.8 : 1.0;
  const completedKm = records.reduce((s, r) => s + (r.distance || 0), 0);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const todayDow = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon...7=Sun

  const templates = {
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

  const template = templates[phase.name] || templates["准备期"];
  const days = [];

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() + i);
    const dayStr = dayDate.toISOString().slice(0, 10);
    const tIdx = (todayDow - 1 + i) % 7;
    const t = template[tIdx];
    const isToday = i === 0;
    const isPast = dayStr < todayStr || (isToday && records.find(r => r.date === dayStr));
    const completedRecord = records.find(r => r.date === dayStr);
    const dayName = weekDays[tIdx];

    if (completedRecord) {
      days.push({
        dayName, date: dayStr, isPast: true, isToday,
        type: `✅ ${completedRecord.distance}km ${completedRecord.avgPace}/km`,
        distance: completedRecord.distance, pace: completedRecord.avgPace,
        hrZone: `${completedRecord.avgHR}bpm`, desc: "已完成",
      });
    } else {
      const adjustedDist = t.type === "休息" ? 0 : Math.round(t.dist * recoveryMultiplier);
      const adjustedPace = recovery.level !== "green" && t.type !== "休息" ? "降低一档" : t.pace;
      const adjustedHR = recovery.level === "red" && t.type !== "休息" ? "严格控制" : t.hr;
      days.push({
        dayName, date: dayStr, isPast, isToday,
        type: t.type, distance: adjustedDist, pace: adjustedPace, hrZone: adjustedHR, desc: t.desc,
      });
    }
  }

  const plannedKm = days.filter(d => !d.isPast).reduce((s, d) => s + d.distance, 0);
  const projectedTotal = Math.round((completedKm + plannedKm) * 10) / 10;

  return { phase, days, completedKm, plannedKm, projectedTotal, targetKm: phase.weeklyKm?.join("-"), recoveryMultiplier };
}

// --- HTML Generation ---

function generateHTML(data, aiAnalysis) {
  const user = data.userInfo || {};
  const fitness = data.fitness || {};
  const records = data.sportRecords || [];
  const details = (data.activityDetails || []).sort((a, b) => b.date.localeCompare(a.date));
  const hrvDays = data.hrv?.days || [];
  const loadEntries = data.trainingLoad || [];
  const maxHR = 220 - getAge(user.birthday || "1990-01-01");
  const tp = fitness.thresholdPace || "4:37";
  const weeksLeft = weeksUntilMarathon();
  const phase = getCurrentPhase(weeksLeft);
  const recovery = assessRecovery(data);

  const hasAI = !!aiAnalysis;
  const aiWorkoutReviews = aiAnalysis?.workoutReviews || [];
  const aiBodyAssessment = aiAnalysis?.bodyAssessment || null;
  const aiTrainingPattern = aiAnalysis?.trainingPatternAnalysis || null;
  const aiWeeklyPlan = aiAnalysis?.weeklyPlan || [];
  const aiCoachAdvice = aiAnalysis?.coachAdvice || null;

  const { start: weekStart, end: weekEnd } = getCurrentWeekBounds();
  const weekRecords = records.filter(r => r.date >= weekStart && r.date <= weekEnd);
  const totalKm = weekRecords.reduce((s, r) => s + (r.distance || 0), 0);
  const totalTL = details.reduce((s, d) => s + (d.trainingLoad || 0), 0);

  const levelColors = { green: "#7ec882", yellow: "#f4c542", red: "#e89898" };
  const levelLabels = { green: "良好", yellow: "注意", red: "警告" };

  const hrvLabels = hrvDays.map(d => d.date.slice(5)).reverse();
  const hrvValues = hrvDays.map(d => d.hrv).reverse();
  const hrvBaseline = data.hrv?.baseline || 60;
  const hrvLow = data.hrv?.normalRange?.[0] || 50;

  const loadLabels = loadEntries.map(e => e.date.slice(5)).reverse();
  const shortLoads = loadEntries.map(e => e.shortTermLoad).reverse();
  const longLoads = loadEntries.map(e => e.longTermLoad).reverse();

  // Pace chart data
  const paceLabels = details.map(d => d.date.slice(5)).reverse();
  const tpSeconds = paceToSeconds(tp);
  const tpMinPerKm = tpSeconds / 60;
  const avgPaceMinPerKm = details.map(d => paceToSeconds(d.avgPace) / 60).reverse();
  const paceColors = avgPaceMinPerKm.map(p => {
    const ratio = p / tpMinPerKm;
    if (ratio > 1.15) return "rgba(124,185,232,.75)";
    if (ratio > 1.05) return "rgba(77,184,164,.75)";
    if (ratio > 0.98) return "rgba(244,197,66,.75)";
    return "rgba(232,152,152,.75)";
  });
  const paceBorders = avgPaceMinPerKm.map(p => {
    const ratio = p / tpMinPerKm;
    if (ratio > 1.15) return "rgba(90,158,199,1)";
    if (ratio > 1.05) return "rgba(60,150,130,1)";
    if (ratio > 0.98) return "rgba(200,160,40,1)";
    return "rgba(192,112,112,1)";
  });

  // Sleep chart data — use dailyHealth for 7-day coverage (data.sleep only has 3 days)
  const healthDays7 = (data.dailyHealth || []).slice(0, 7);
  const sleepLabels = healthDays7.map(s => {
    const d = s.date || "";
    return d.length === 8 ? d.slice(4, 6) + "/" + d.slice(6, 8) : d.slice(5);
  });
  const sleepScores = healthDays7.map(s => s.sleepScore);
  const parseSleepTime = (str) => {
    if (!str) return 0;
    const h = str.match(/(\d+)\s*h/); const m = str.match(/(\d+)\s*min/);
    return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
  };
  const deepHours = healthDays7.map(d => Math.round(parseSleepTime(d.deepSleep) / 60 * 10) / 10);
  const lightHours = healthDays7.map(d => Math.round(parseSleepTime(d.lightSleep) / 60 * 10) / 10);
  const remHours = healthDays7.map(d => Math.round(parseSleepTime(d.remSleep) / 60 * 10) / 10);

  // Rule-engine fallback for workout review
  const ruleReview = !hasAI || !aiWorkoutReviews.length ? reviewLatestWorkout(details[0], tp, maxHR) : null;

  // Rule-engine fallback for weekly plan
  const rulePlan = !hasAI || !aiWeeklyPlan.length ? generateRuleBasedPlan(data, recovery) : null;

  // Weekly km progress
  const kmTargetMax = (phase.weeklyKm || [60, 60])[1];
  const kmTargetMin = (phase.weeklyKm || [45, 45])[0];
  const kmPct = kmTargetMax > 0 ? Math.min(100, Math.round((totalKm / kmTargetMax) * 100)) : 0;

  const latestHRV = hrvDays[0]?.hrv;
  const hrvNormalLow = data.hrv?.normalRange?.[0] || 50;
  const hrvWarning = latestHRV && latestHRV < hrvNormalLow;
  const loadRatio = loadEntries[0]?.loadRatio;
  const loadWarning = loadRatio && loadRatio > 1.3;
  const kmWarning = totalKm > kmTargetMax;

  // Per-second pace+HR data from TCX (finest granularity)
  let secData = [];
  const latestActivity = details[0];
  if (latestActivity?.labelId) {
    const tcxPath = path.join(PROJECT_ROOT, "data", "tcx", `${latestActivity.labelId}.tcx`);
    if (existsSync(tcxPath)) {
      try {
        const tps = parseTCX(tcxPath);
        const startTime = tps.length > 0 ? new Date(tps[0].time).getTime() : 0;
        secData = tps
          .filter(tp => tp.speed > 0 && tp.hr > 0)
          .map(tp => {
            const elapsedSec = Math.round((new Date(tp.time).getTime() - startTime) / 1000);
            const paceMinPerKm = 60 / tp.speed;
            return { elapsedSec, paceMinPerKm, hr: tp.hr };
          })
          .filter(d => d.paceMinPerKm >= 3 && d.paceMinPerKm <= 15);
        // Lightweight SMA-3 smoothing on HR to reduce burrs
        if (secData.length > 3) {
          const sma = [secData[0]];
          for (let i = 1; i < secData.length - 1; i++) {
            sma.push({ ...secData[i], hr: Math.round((secData[i-1].hr + secData[i].hr + secData[i+1].hr) / 3) });
          }
          sma.push(secData[secData.length - 1]);
          secData = sma;
        }
      } catch {}
    }
  }
  const segChartHTML = secData.length >= 10 ? `
  <div class="chart-box full-width" style="margin-bottom:16px;height:300px;display:flex;flex-direction:column">
    <h3>逐秒配速 & 心率</h3>
    <canvas id="secPaceHrChart" style="flex:1;min-height:0"></canvas>
  </div>
` : "";

  // Source badge helper
  const sourceBadge = hasAI
    ? `<span class="source-badge badge-ai">AI 大语言模型分析</span>`
    : `<span class="source-badge badge-rule">规则引擎分析</span>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${user.nickname || "COROS"} 训练复盘 ${data.fetchDate}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#faf6ef;--card:#fff;--border:#e8dfd3;--text:#5a5247;--text-strong:#4a4238;--muted:#9e9484;--accent:#7ec882;--accent2:#f4c542;--accent3:#e89898;--accent4:#7cb9e8;--shadow:rgba(90,82,71,.05);--row-hover:rgba(126,200,130,.04);--finding-border:rgba(232,223,211,.3)}
[data-theme="dark"]{--bg:#1a1b26;--card:#24283b;--border:#3b4261;--text:#a9b1d6;--text-strong:#c0caf5;--muted:#565f89;--accent:#9ece6a;--accent2:#e0af68;--accent3:#f7768e;--accent4:#7aa2f7;--shadow:rgba(0,0,0,.2);--row-hover:rgba(158,206,106,.06);--finding-border:rgba(59,66,97,.6)}
body{font-family:'Hiragino Sans','Yu Gothic',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:20px;max-width:1200px;margin:0 auto;transition:background .3s,color .3s}
h1{font-size:1.8rem;font-weight:800;color:var(--accent);margin-bottom:4px}
.subtitle{color:var(--muted);font-size:.85rem;margin-bottom:28px}
.section{margin-bottom:36px}
.section-title{font-size:1.1rem;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';width:4px;height:18px;background:linear-gradient(135deg,var(--accent),#4db8a4);border-radius:2px}
.section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.section-title-row{display:flex;align-items:center;gap:10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 2px 6px var(--shadow);transition:background .3s,border-color .3s}
.card .label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.card .value{font-size:1.6rem;font-weight:800;color:var(--text-strong)}
.card .sub{font-size:.72rem;color:var(--muted);margin-top:2px}
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.chart-box{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 2px 6px var(--shadow);transition:background .3s,border-color .3s}
.chart-box h3{font-size:.85rem;font-weight:600;margin-bottom:10px;color:var(--muted)}
.full-width{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{text-align:left;color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:2px solid var(--border)}
td{padding:8px 10px;border-bottom:1px solid var(--border)}
tr:hover td{background:var(--row-hover)}
.recovery-indicator{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:6px}
.badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:.7rem;font-weight:600;margin:2px}
.badge-green{background:rgba(126,200,130,.2);color:#5aa65e}
.badge-yellow{background:rgba(244,197,66,.2);color:#c9a030}
.badge-red{background:rgba(232,152,152,.2);color:#c07070}
.badge-blue{background:rgba(124,185,232,.2);color:#5a9ec7}
.review-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.review-box{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 2px 6px var(--shadow);transition:background .3s,border-color .3s}
.review-box h4{font-size:.85rem;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.finding-item{font-size:.82rem;padding:4px 0;border-bottom:1px solid var(--finding-border)}
.finding-item:last-child{border-bottom:none}
.plan-today{background:rgba(77,184,164,.06)!important}
[data-theme="dark"] .plan-today{background:rgba(158,206,106,.08)!important}
.header-row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px}
.theme-toggle{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:6px 10px;cursor:pointer;font-size:1.1rem;line-height:1;color:var(--muted);transition:background .3s,border-color .3s}
.theme-toggle:hover{color:var(--text-strong);border-color:var(--accent)}
/* New styles */
.source-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:.7rem;font-weight:600;letter-spacing:.3px}
.badge-ai{background:rgba(126,200,130,.15);color:#5aa65e;border:1px solid rgba(126,200,130,.3)}
[data-theme="dark"] .badge-ai{background:rgba(158,206,106,.12);color:#9ece6a;border-color:rgba(158,206,106,.3)}
.badge-rule{background:rgba(158,148,132,.15);color:#9e9484;border:1px solid rgba(158,148,132,.3)}
[data-theme="dark"] .badge-rule{background:rgba(86,95,137,.15);color:#565f89;border-color:rgba(86,95,137,.3)}
.ai-insight{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:0 14px 14px 0;padding:16px;box-shadow:0 2px 6px var(--shadow);transition:background .3s,border-color .3s}
.ai-insight h4{font-size:.85rem;font-weight:600;margin-bottom:8px;color:var(--accent)}
.ai-insight p{font-size:.85rem;line-height:1.7;margin-bottom:6px}
.ai-insight .detail-text{font-size:.82rem;color:var(--text);line-height:1.8;white-space:pre-line}
.coach-advice{background:linear-gradient(135deg,rgba(126,200,130,.08),rgba(77,184,164,.08));border:1px solid rgba(126,200,130,.2);border-left:4px solid var(--accent);border-radius:0 14px 14px 0;padding:20px;box-shadow:0 2px 6px var(--shadow);transition:background .3s,border-color .3s}
[data-theme="dark"] .coach-advice{background:linear-gradient(135deg,rgba(158,206,106,.06),rgba(77,184,164,.06));border-color:rgba(158,206,106,.2)}
.coach-advice h4{font-size:.9rem;font-weight:700;margin-bottom:10px;color:var(--accent);display:flex;align-items:center;gap:6px}
.coach-advice p{font-size:.88rem;line-height:1.8}
.progress-bar-container{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 2px 6px var(--shadow);margin-bottom:14px;transition:background .3s,border-color .3s}
.progress-bar-track{width:100%;height:10px;background:var(--border);border-radius:5px;overflow:hidden;margin:8px 0}
.progress-bar-fill{height:100%;border-radius:5px;transition:width .6s ease}
.progress-bar-labels{display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted)}
.analysis-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.prescription-toggle{cursor:pointer;color:var(--accent);font-size:.75rem;text-decoration:underline;user-select:none}
.prescription-detail{display:none;margin-top:8px;padding:10px 12px;background:rgba(126,200,130,.04);border-radius:8px;font-size:.78rem;line-height:1.7}
.prescription-detail.open{display:block}
[data-theme="dark"] .prescription-detail{background:rgba(158,206,106,.06)}
.prescription-detail dt{font-weight:600;color:var(--muted);margin-top:4px}
.prescription-detail dt:first-child{margin-top:0}
.prescription-detail dd{margin-left:0;margin-bottom:4px}
.body-assessment-level{display:inline-block;padding:4px 12px;border-radius:20px;font-size:.8rem;font-weight:700;margin-bottom:8px}
.body-assessment-level.green{background:rgba(126,200,130,.15);color:#5aa65e}
.body-assessment-level.yellow{background:rgba(244,197,66,.15);color:#c9a030}
.body-assessment-level.red{background:rgba(232,152,152,.15);color:#c07070}
[data-theme="dark"] .body-assessment-level.green{background:rgba(158,206,106,.12);color:#9ece6a}
[data-theme="dark"] .body-assessment-level.yellow{background:rgba(224,175,104,.12);color:#e0af68}
[data-theme="dark"] .body-assessment-level.red{background:rgba(247,118,142,.12);color:#f7768e}
.tag-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.72rem;font-weight:500}
.tag-strength{background:rgba(126,200,130,.12);color:#5aa65e}
.tag-risk{background:rgba(232,152,152,.12);color:#c07070}
.tag-suggestion{background:rgba(124,185,232,.12);color:#5a9ec7}
[data-theme="dark"] .tag-strength{background:rgba(158,206,106,.1);color:#9ece6a}
[data-theme="dark"] .tag-risk{background:rgba(247,118,142,.1);color:#f7768e}
[data-theme="dark"] .tag-suggestion{background:rgba(122,162,247,.1);color:#7aa2f7}
@media(max-width:768px){.charts-grid,.review-grid,.analysis-grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>

<div class="header-row">
  <div>
    <h1>${user.nickname || "COROS"} 训练复盘</h1>
    <p class="subtitle">${data.fetchDate} | ${user.nickname || "-"} | 距首马 ${weeksLeft} 周 (${phase.name}) | 目标 3:30:00</p>
  </div>
  <button class="theme-toggle" id="themeToggle" title="切换主题">🌙</button>
</div>

<!-- ==================== Section 1: 个人训练关键指标 ==================== -->
<div class="section">
  <div class="section-header">
    <div class="section-title-row">
      <div class="section-title">个人训练关键指标</div>
    </div>
  </div>
  <div class="cards">
    <div class="card"><div class="label">VO2max</div><div class="value">${fitness.vo2max || "-"}</div><div class="sub">阈值配速 ${tp}/km</div></div>
    <div class="card"><div class="label">全马预测</div><div class="value">${fitness.predMarathon || "-"}</div><div class="sub">目标 3:30:00</div></div>
    <div class="card"><div class="label">距首马</div><div class="value">${weeksLeft}<span style="font-size:.9rem">周</span></div><div class="sub">${phase.name}${phase.currentWeek > 0 ? " W" + phase.currentWeek : ""} | ${phase.focus}</div></div>
    <div class="card"><div class="label">本周跑量</div><div class="value"${kmWarning ? ' style="color:#c9a030"' : ""}>${totalKm.toFixed(1)}<span style="font-size:.9rem">km</span></div><div class="sub">${kmWarning ? "⚠️ 超出目标上限" : `目标 ${kmTargetMin}-${kmTargetMax}km`}<br><span style="font-size:.65rem;color:var(--muted)">周期 ${weekStart.slice(5).replace('-','/')}~${weekEnd.slice(5).replace('-','/')}</span></div></div>
    <div class="card"><div class="label">训练负荷</div><div class="value"${loadWarning ? ' style="color:#c9a030"' : ""}>${totalTL}<span style="font-size:.9rem">TL</span></div><div class="sub">负荷比 ${loadRatio || "-"}（目标 0.8-1.3）${loadWarning ? " ⚠️偏高" : ""}</div></div>
    <div class="card"><div class="label">恢复状态</div><div class="value" style="color:${levelColors[recovery.level]}">${recovery.recoveryPct || "-"}%</div><div class="sub"><span class="recovery-indicator" style="background:${levelColors[recovery.level]}"></span>${levelLabels[recovery.level]}</div></div>
    <div class="card"><div class="label">最新HRV</div><div class="value" style="color:${hrvWarning ? levelColors.yellow : levelColors.green}">${latestHRV || "-"}<span style="font-size:.9rem">ms</span></div><div class="sub"><span class="recovery-indicator" style="background:${hrvWarning ? levelColors.yellow : levelColors.green}"></span>${hrvWarning ? "偏低" : "正常"} | 基线 ${recovery.baseline || "-"}ms</div></div>
  </div>
</div>

<!-- ==================== Section 2: 最近一次训练分析 ==================== -->
<div class="section">
  <div class="section-header">
    <div class="section-title-row">
      <div class="section-title">最近一次训练分析${(() => {
        const d = hasAI && aiWorkoutReviews.length > 0 ? details[0] : ruleReview?.activity;
        return d ? `（${d.date}）` : "";
      })()}</div>
      ${sourceBadge}
    </div>
  </div>

${(() => {
  const a = details[0];
  // AI-based review
  if (hasAI && aiWorkoutReviews.length > 0) {
    const r = aiWorkoutReviews[0];
    if (!a) return '<p style="color:var(--muted)">暂无训练数据</p>';
    const paceRatio = paceToSeconds(a.avgPace) / paceToSeconds(tp);
    let intensityZone = "未知";
    if (paceRatio > 1.15) intensityZone = "轻松跑 (E区)";
    else if (paceRatio > 1.05) intensityZone = "有氧耐力 (E-M区)";
    else if (paceRatio > 0.98) intensityZone = "节奏跑 (T区)";
    else if (paceRatio > 0.92) intensityZone = "阈值跑 (T-I区)";
    else intensityZone = "间歇区 (I区)";
    const hrPct = maxHR > 0 ? Math.round((a.avgHR / maxHR) * 100) : 0;
    const cadenceGap = a.avgCadence ? Math.max(0, 180 - a.avgCadence) : null;

    return `
  <div class="cards" style="margin-bottom:16px">
    <div class="card"><div class="label">距离/时间</div><div class="value">${a.distance}<span style="font-size:.9rem">km</span></div><div class="sub">${a.workoutTime}</div></div>
    <div class="card"><div class="label">配速</div><div class="value">${a.avgPace}<span style="font-size:.9rem">/km</span></div><div class="sub">最快 ${a.bestKm || "-"} | ${intensityZone}</div></div>
    <div class="card"><div class="label">心率</div><div class="value">${a.avgHR}<span style="font-size:.9rem">bpm</span></div><div class="sub">${hrPct}% HRmax</div></div>
    <div class="card"><div class="label">步频</div><div class="value">${a.avgCadence || "-"}<span style="font-size:.9rem">spm</span></div><div class="sub">${cadenceGap ? `低于180目标${cadenceGap}spm` : "达标"}</div></div>
    <div class="card"><div class="label">训练负荷</div><div class="value">${a.trainingLoad || "-"}<span style="font-size:.9rem">TL</span></div><div class="sub">${a.performance || "-"}</div></div>
    <div class="card"><div class="label">天气</div><div class="value" style="font-size:1.2rem">${a.weather?.weatherDesc || "-"}</div><div class="sub">${a.weather?.tempMax ? a.weather.tempMax + "°C" : ""} ${a.weather?.feelsLikeMax ? "体感" + a.weather.feelsLikeMax + "°C" : ""} ${a.weather?.humidity ? "湿度" + a.weather.humidity + "%" : ""}</div></div>
  </div>
  ${segChartHTML}
  <div class="review-grid">
    <div class="ai-insight">
      <h4>训练概要</h4>
      <p>${r.summary || ""}</p>
      ${r.detailedAnalysis ? `<div class="detail-text" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--finding-border)">${r.detailedAnalysis}</div>` : ""}
    </div>
    <div class="review-box">
      <h4>亮点</h4>
      ${(r.positives || []).length ? r.positives.map(p => `<div class="finding-item" style="color:#5aa65e">${p}</div>`).join("") : '<div class="finding-item" style="color:var(--muted)">暂无</div>'}
      <h4 style="margin-top:12px">改进方向</h4>
      ${(r.improvements || []).length ? r.improvements.map(i => `<div class="finding-item" style="color:#c9a030">${i}</div>`).join("") : '<div class="finding-item" style="color:var(--muted)">暂无</div>'}
    </div>
  </div>`;
  }

  // Rule-engine fallback
  if (ruleReview) {
    const a = ruleReview.activity;
    return `
  <div class="cards" style="margin-bottom:16px">
    <div class="card"><div class="label">距离/时间</div><div class="value">${a.distance}<span style="font-size:.9rem">km</span></div><div class="sub">${a.workoutTime}</div></div>
    <div class="card"><div class="label">配速</div><div class="value">${a.avgPace}<span style="font-size:.9rem">/km</span></div><div class="sub">最快 ${a.bestKm || "-"} | ${ruleReview.intensityZone}</div></div>
    <div class="card"><div class="label">心率</div><div class="value">${a.avgHR}<span style="font-size:.9rem">bpm</span></div><div class="sub">${Math.round(ruleReview.hrPct)}% HRmax</div></div>
    <div class="card"><div class="label">步频</div><div class="value">${a.avgCadence || "-"}<span style="font-size:.9rem">spm</span></div><div class="sub">${ruleReview.cadenceGap ? `低于180目标${ruleReview.cadenceGap}spm` : "达标"}</div></div>
    <div class="card"><div class="label">训练负荷</div><div class="value">${a.trainingLoad || "-"}<span style="font-size:.9rem">TL</span></div><div class="sub">${a.performance || "-"}</div></div>
  </div>
  ${segChartHTML}
  <div class="review-grid">
    <div class="review-box">
      <h4>训练分析</h4>
      ${ruleReview.findings.map(f => `<div class="finding-item">${f}</div>`).join("")}
    </div>
    <div class="review-box">
      <h4>亮点</h4>
      ${ruleReview.positives.length ? ruleReview.positives.map(p => `<div class="finding-item" style="color:#5aa65e">${p}</div>`).join("") : '<div class="finding-item" style="color:var(--muted)">暂无</div>'}
      <h4 style="margin-top:12px">改进方向</h4>
      ${ruleReview.improvements.length ? ruleReview.improvements.map(i => `<div class="finding-item" style="color:#c9a030">${i}</div>`).join("") : '<div class="finding-item" style="color:var(--muted)">暂无</div>'}
    </div>
  </div>`;
  }

  return '<p style="color:var(--muted)">暂无训练数据</p>';
})()}

${aiWorkoutReviews.length > 1 ? `
  <div style="margin-top:16px">
    <div class="section-title" style="font-size:.95rem">其他近期训练</div>
    <table>
      <tr><th>日期</th><th>概要</th><th>亮点</th><th>改进</th></tr>
      ${aiWorkoutReviews.slice(1).map(r => `<tr>
        <td>${r.date || "-"}</td>
        <td style="max-width:300px">${r.summary || "-"}</td>
        <td>${(r.positives || []).map(p => `<span class="badge badge-green">${p}</span>`).join("") || "-"}</td>
        <td>${(r.improvements || []).map(i => `<span class="badge badge-yellow">${i}</span>`).join("") || "-"}</td>
      </tr>`).join("")}
    </table>
  </div>
` : (details.length > 1 ? `
  <div style="margin-top:16px">
    <div class="section-title" style="font-size:.95rem">其他近期训练</div>
    <table>
      <tr><th>日期</th><th>距离</th><th>配速</th><th>心率</th><th>步频</th><th>训练负荷</th><th>表现</th><th>天气</th></tr>
      ${details.slice(1).map(d => `<tr>
        <td>${d.date}</td>
        <td>${d.distance}km</td>
        <td>${d.avgPace}/km</td>
        <td>${d.avgHR}bpm (${Math.round((d.avgHR / maxHR) * 100)}%)</td>
        <td>${d.avgCadence || "-"}spm</td>
        <td>${d.trainingLoad || "-"}TL</td>
        <td>${d.performance || "-"}</td>
        <td>${d.weather?.weatherDesc || "-"} ${d.weather?.tempMax || ""}°C</td>
      </tr>`).join("")}
    </table>
  </div>
` : "")}
</div>

<!-- ==================== Section 3: 最近7天训练分析 ==================== -->
<div class="section">
  <div class="section-header">
    <div class="section-title-row">
      <div class="section-title">最近7天训练分析</div>
      ${hasAI ? sourceBadge : ""}
    </div>
  </div>

  <!-- Charts -->
  <div class="charts-grid">
    <div class="chart-box">
      <h3>HRV 7日趋势</h3>
      <canvas id="hrvChart"></canvas>
    </div>
    <div class="chart-box">
      <h3>训练负荷趋势</h3>
      <canvas id="loadChart"></canvas>
    </div>
    <div class="chart-box">
      <h3>最近训练配速 vs 阈值</h3>
      <canvas id="paceChart"></canvas>
    </div>
    ${sleepScores.some(s => s != null) ? `
    <div class="chart-box">
      <h3>睡眠质量趋势（近7天）</h3>
      <canvas id="sleepChart"></canvas>
    </div>
    ` : ""}
  </div>

  <!-- Workouts Table -->
  ${details.length > 0 ? `
  <div style="margin-top:20px">
    <div class="section-title" style="font-size:.95rem">近期训练一览</div>
    <table>
      <tr><th>日期</th><th>距离</th><th>配速</th><th>心率</th><th>步频</th><th>训练负荷</th><th>表现</th><th>天气</th></tr>
      ${details.map(d => `<tr>
        <td>${d.date}</td>
        <td>${d.distance}km</td>
        <td>${d.avgPace}/km</td>
        <td>${d.avgHR}bpm (${Math.round((d.avgHR / maxHR) * 100)}%)</td>
        <td>${d.avgCadence || "-"}spm</td>
        <td>${d.trainingLoad || "-"}TL</td>
        <td>${d.performance || "-"}</td>
        <td>${d.weather?.weatherDesc || "-"} ${d.weather?.tempMax || ""}°C</td>
      </tr>`).join("")}
    </table>
  </div>
  ` : ""}

  <!-- Recovery Detail Cards -->
  <div style="margin-top:20px">
    <div class="section-title" style="font-size:.95rem">恢复指标</div>
    <div class="cards">
      <div class="card"><div class="label">恢复度</div><div class="value" style="color:${levelColors[recovery.level]}">${recovery.recoveryPct || "-"}%</div><div class="sub">${data.recovery?.level || "-"}</div></div>
      <div class="card"><div class="label">HRV连续偏低</div><div class="value">${recovery.consecutiveBelow}<span style="font-size:.9rem">天</span></div><div class="sub">${recovery.consecutiveBelow >= 2 ? "⚠️ 需关注" : "正常"}</div></div>
      <div class="card"><div class="label">睡眠(最新)</div><div class="value">${data.sleep?.[data.sleep.length - 1]?.sleepScore || data.dailyHealth?.[data.dailyHealth.length - 1]?.sleepScore || "-"}</div><div class="sub">${data.sleep?.[data.sleep.length - 1]?.sleepWindow || "-"}</div></div>
      <div class="card"><div class="label">负荷比</div><div class="value">${loadEntries[0]?.loadRatio || "-"}</div><div class="sub">${loadEntries[0]?.comment || "-"}</div></div>
      <div class="card"><div class="label">预计完全恢复</div><div class="value">${data.recovery?.estimatedFullRecovery || "-"}</div><div class="sub">${data.recovery?.level || "-"}</div></div>
    </div>
  </div>

  <!-- AI Body Assessment & Training Pattern -->
  ${hasAI && (aiBodyAssessment || aiTrainingPattern) ? `
  <div style="margin-top:14px">
    <div class="analysis-grid">
      ${aiBodyAssessment ? `
      <div class="ai-insight">
        <h4>身体状态评估</h4>
        <div class="body-assessment-level ${aiBodyAssessment.overallLevel || "green"}">${{green: "状态良好", yellow: "需要关注", red: "警告"}[aiBodyAssessment.overallLevel] || "状态良好"}</div>
        <p>${aiBodyAssessment.summary || ""}</p>
        ${(aiBodyAssessment.details || []).length ? `<ul style="margin:8px 0 0 16px;font-size:.82rem;line-height:1.7">${aiBodyAssessment.details.map(d => `<li>${d}</li>`).join("")}</ul>` : ""}
        ${(aiBodyAssessment.recommendations || []).length ? `<div style="margin-top:8px;font-size:.8rem;color:var(--muted)">建议：${aiBodyAssessment.recommendations.join("；")}</div>` : ""}
      </div>
      ` : '<div class="review-box"><p style="color:var(--muted)">暂无身体状态评估数据</p></div>'}

      ${aiTrainingPattern ? `
      <div class="ai-insight">
        <h4>训练模式分析</h4>
        <p>${aiTrainingPattern.summary || ""}</p>
        ${(aiTrainingPattern.strengths || []).length ? `<div style="margin-top:8px"><div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">优势</div><div class="tag-list">${aiTrainingPattern.strengths.map(s => `<span class="tag tag-strength">${s}</span>`).join("")}</div></div>` : ""}
        ${(aiTrainingPattern.risks || []).length ? `<div style="margin-top:8px"><div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">风险</div><div class="tag-list">${aiTrainingPattern.risks.map(r => `<span class="tag tag-risk">${r}</span>`).join("")}</div></div>` : ""}
        ${(aiTrainingPattern.suggestions || []).length ? `<div style="margin-top:8px"><div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">建议</div><div class="tag-list">${aiTrainingPattern.suggestions.map(s => `<span class="tag tag-suggestion">${s}</span>`).join("")}</div></div>` : ""}
      </div>
      ` : '<div class="review-box"><p style="color:var(--muted)">暂无训练模式分析数据</p></div>'}
    </div>
  </div>
  ` : ""}
</div>

<!-- ==================== Section 4: 下一阶段训练计划 ==================== -->
<div class="section">
  <div class="section-header">
    <div class="section-title-row">
      <div class="section-title">下一阶段训练计划</div>
      ${sourceBadge}
    </div>
  </div>

  <!-- Phase info + Progress bar -->
  <div style="margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="font-size:.85rem;font-weight:600">${phase.name}${phase.currentWeek > 0 ? " (W" + phase.currentWeek + ")" : ""} — ${phase.focus}</span>
      <span style="font-size:.8rem;color:var(--muted)">目标 ${kmTargetMin}-${kmTargetMax}km/周</span>
    </div>
    <div class="progress-bar-container" style="margin-bottom:0">
      <div class="progress-bar-labels">
        <span>已完成 ${totalKm.toFixed(1)}km</span>
        <span>${kmPct}%</span>
        <span>目标 ${kmTargetMax}km</span>
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width:${kmPct}%;background:${kmPct > 100 ? levelColors.yellow : kmPct > 80 ? levelColors.green : levelColors.red}"></div>
      </div>
    </div>
  </div>

  <!-- Weekly Plan Table -->
  ${(() => {
    if (hasAI && aiWeeklyPlan.length > 0) {
      return `
  <table>
    <tr><th>日期</th><th>类型</th><th>距离</th><th>配速区间</th><th>心率区间</th><th>说明</th><th>处方</th></tr>
    ${aiWeeklyPlan.map(d => {
      const hasPrescription = d.prescription && (d.prescription.warmup || d.prescription.main || d.prescription.cooldown || d.prescription.notes);
      const pId = "p-" + d.dayIndex;
      return `<tr class="${d.type === "休息" ? "" : ""}">
        <td>${d.dayName || ""} ${(d.date || "").slice(5)}</td>
        <td>${d.type}</td>
        <td>${d.totalDistance > 0 ? d.totalDistance + "km" : "-"}</td>
        <td>${d.paceZone || "-"}</td>
        <td>${d.hrZone || "-"}</td>
        <td>${d.description || "-"}</td>
        <td>${hasPrescription ? `<span class="prescription-toggle" onclick="document.getElementById('${pId}').classList.toggle('open')">展开详情</span><div class="prescription-detail" id="${pId}">${d.prescription.warmup ? `<dt>热身</dt><dd>${d.prescription.warmup}</dd>` : ""}${d.prescription.main ? `<dt>主课</dt><dd>${d.prescription.main}</dd>` : ""}${d.prescription.cooldown ? `<dt>冷身</dt><dd>${d.prescription.cooldown}</dd>` : ""}${d.prescription.notes ? `<dt>备注</dt><dd>${d.prescription.notes}</dd>` : ""}</div>` : "-"}</td>
      </tr>`;
    }).join("")}
  </table>`;
    }

    // Rule-engine fallback
    if (rulePlan) {
      return `
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:12px">
    已完成 ${rulePlan.completedKm.toFixed(1)}km | 计划剩余 ${rulePlan.plannedKm}km | 预计周总 ${rulePlan.projectedTotal}km（目标 ${rulePlan.targetKm}km）
    ${recovery.level !== "green" ? ` | 恢复调整系数 ×${rulePlan.recoveryMultiplier}` : ""}
  </p>
  <table>
    <tr><th>日期</th><th>类型</th><th>距离</th><th>配速</th><th>心率</th><th>说明</th></tr>
    ${rulePlan.days.map(d => `<tr class="${d.isToday ? "plan-today" : ""}">
      <td>${d.dayName} ${d.date.slice(5)}${d.isToday ? " 📍" : ""}</td>
      <td>${d.type}</td>
      <td>${d.distance > 0 ? d.distance + "km" : "-"}</td>
      <td>${d.pace}</td>
      <td>${d.hrZone}</td>
      <td>${d.desc}</td>
    </tr>`).join("")}
  </table>`;
    }

    return '<p style="color:var(--muted)">暂无训练计划</p>';
  })()}

  <!-- Coach Advice -->
  ${aiCoachAdvice ? `
  <div class="coach-advice" style="margin-top:20px">
    <h4>AI 教练建议</h4>
    <p>${aiCoachAdvice}</p>
  </div>
  ` : ""}
</div>

<script>
// HRV Chart
new Chart(document.getElementById('hrvChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(hrvLabels)},
    datasets: [{
      label: 'HRV',
      data: ${JSON.stringify(hrvValues)},
      borderColor: '#7ec882',
      backgroundColor: 'rgba(126,200,130,.1)',
      fill: true, tension: .3, pointRadius: 4,
    }, {
      label: '基线',
      data: Array(${hrvLabels.length}).fill(${hrvBaseline}),
      borderColor: '#9e9484', borderDash: [5, 5], pointRadius: 0, fill: false,
    }, {
      label: '正常下限',
      data: Array(${hrvLabels.length}).fill(${hrvLow}),
      borderColor: '#e89898', borderDash: [3, 3], pointRadius: 0, fill: false,
    }]
  },
  options: { responsive: true, plugins: { legend: { display: true, position: 'bottom', labels: { font: { size: 10 } } } }, scales: { y: { beginAtZero: false } } }
});

// Training Load Chart
new Chart(document.getElementById('loadChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(loadLabels)},
    datasets: [{
      label: '短期负荷',
      data: ${JSON.stringify(shortLoads)},
      backgroundColor: 'rgba(124,185,232,.7)',
    }, {
      label: '长期负荷',
      data: ${JSON.stringify(longLoads)},
      backgroundColor: 'rgba(196,166,216,.7)',
    }]
  },
  options: { responsive: true, plugins: { legend: { display: true, position: 'bottom', labels: { font: { size: 10 } } } }, scales: { y: { beginAtZero: true } } }
});

// Pace Chart
function fmtPace(v) { const m = Math.floor(v); const s = Math.round((v - m) * 60); return m + ':' + String(s).padStart(2, '0'); }
new Chart(document.getElementById('paceChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(paceLabels)},
    datasets: [{
      label: '平均配速',
      data: ${JSON.stringify(avgPaceMinPerKm)},
      backgroundColor: ${JSON.stringify(paceColors)},
      borderColor: ${JSON.stringify(paceBorders)},
      borderWidth: 1.5, barPercentage: 0.6,
    }, {
      label: '阈值 ' + fmtPace(${tpMinPerKm.toFixed(3)}) + '/km',
      data: Array(${paceLabels.length}).fill(${tpMinPerKm.toFixed(3)}),
      type: 'line',
      borderColor: '#e89898', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false,
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, usePointStyle: true } },
      tooltip: { callbacks: { label: function(ctx) {
        if (ctx.dataset.type === 'line') return ctx.dataset.label;
        const v = ctx.parsed.y;
        const ratio = v / ${tpMinPerKm.toFixed(3)};
        let zone = ratio > 1.15 ? 'E区' : ratio > 1.05 ? 'E-M区' : ratio > 0.98 ? 'T区' : 'I区';
        return fmtPace(v) + '/km (' + zone + ', ' + Math.round(ratio * 100) + '%阈值)';
      } } }
    },
    scales: { y: { reverse: true, title: { display: true, text: '配速 (越低越快)' },
      ticks: { callback: function(v) { return fmtPace(v); } }
    } }
  }
});

${secData.length >= 10 ? `
// Vertical crosshair plugin for per-second chart
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw: function(chart) {
    if (chart.tooltip._active && chart.tooltip._active.length) {
      const active = chart.tooltip._active[0];
      const ctx = chart.ctx;
      const x = active.element.x;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, chart.scales.y.top);
      ctx.lineTo(x, chart.scales.y.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#9e9484';
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.restore();
    }
  }
};
Chart.register(crosshairPlugin);
// Per-second Pace & HR Chart
new Chart(document.getElementById('secPaceHrChart'), {
  type: 'line',
  data: {
    datasets: [{
      label: '配速',
      data: ${JSON.stringify(secData.map(d => ({x: d.elapsedSec, y: d.paceMinPerKm})))},
      borderColor: '#7ec882',
      backgroundColor: 'rgba(126,200,130,.1)',
      fill: true, tension: 0, pointRadius: 0,
      yAxisID: 'y',
    }, {
      label: '心率',
      data: ${JSON.stringify(secData.map(d => ({x: d.elapsedSec, y: d.hr})))},
      borderColor: '#e89898',
      backgroundColor: 'rgba(232,152,152,.1)',
      fill: false, tension: 0.3, pointRadius: 0,
      yAxisID: 'y1',
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, usePointStyle: true } },
      tooltip: { callbacks: {
        title: function(ctx) {
          const sec = ctx[0].parsed.x;
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          return m + ':' + String(s).padStart(2, '0');
        },
        label: function(ctx) {
          if (ctx.datasetIndex === 0) return fmtPace(ctx.parsed.y) + '/km';
          return ctx.parsed.y + ' bpm';
        }
      } }
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: '运动时间' },
        ticks: { callback: function(v) {
          const m = Math.floor(v / 60);
          const s = Math.round(v % 60);
          return m + ':' + String(s).padStart(2, '0');
        } } },
      y: { reverse: true, position: 'left', title: { display: true, text: '配速 (越低越快)' },
        ticks: { callback: function(v) { return fmtPace(v); } } },
      y1: { position: 'right', title: { display: true, text: '心率 (bpm)' },
        grid: { drawOnChartArea: false } }
    }
  }
});` : ""}

${sleepLabels.length > 0 ? `
// Sleep Chart — stacked bars (deep + light + REM) + sleep score line overlay
new Chart(document.getElementById('sleepChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(sleepLabels)},
    datasets: [{
      label: '深睡',
      data: ${JSON.stringify(deepHours)},
      backgroundColor: 'rgba(92,124,200,.8)',
      yAxisID: 'y',
    }, {
      label: '浅睡',
      data: ${JSON.stringify(lightHours)},
      backgroundColor: 'rgba(140,170,220,.7)',
      yAxisID: 'y',
    }, {
      label: 'REM',
      data: ${JSON.stringify(remHours)},
      backgroundColor: 'rgba(200,215,240,.6)',
      yAxisID: 'y',
    }, {
      label: '睡眠评分',
      type: 'line',
      data: ${JSON.stringify(sleepScores)},
      borderColor: '#7ec882',
      backgroundColor: 'rgba(126,200,130,.1)',
      fill: false, tension: .3, pointRadius: 5,
      pointBackgroundColor: '#7ec882',
      yAxisID: 'y1',
      order: 0,
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, usePointStyle: true } },
      tooltip: { callbacks: { label: function(ctx) {
        if (ctx.datasetIndex < 3) {
          const h = Math.floor(ctx.parsed.y);
          const m = Math.round((ctx.parsed.y - h) * 60);
          return ctx.dataset.label + ': ' + h + 'h' + String(m).padStart(2, '0') + 'min';
        }
        return ctx.dataset.label + ': ' + ctx.parsed.y;
      } } } },
    scales: {
      x: { stacked: true },
      y: { stacked: true, position: 'left', min: 0, max: 12,
        title: { display: true, text: '睡眠时长 (h)' },
        ticks: { stepSize: 2 } },
      y1: { position: 'right', min: 0, max: 100,
        title: { display: true, text: '睡眠评分' },
        grid: { drawOnChartArea: false } }
    }
  }
});
` : ""}

// Theme toggle
(function(){
  const btn = document.getElementById('themeToggle');
  const root = document.documentElement;
  const saved = localStorage.getItem('coros-theme') || 'dark';
  root.setAttribute('data-theme', saved); btn.textContent = saved === 'dark' ? '☀️' : '🌙';
  btn.addEventListener('click', function(){
    const isDark = root.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    btn.textContent = next === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('coros-theme', next);
    updateChartColors();
  });
  function getThemeColor(varName) {
    return getComputedStyle(root).getPropertyValue(varName).trim();
  }
  function updateChartColors() {
    const gridColor = getThemeColor('--border');
    const tickColor = getThemeColor('--muted');
    Chart.defaults.color = tickColor;
    Chart.defaults.borderColor = gridColor;
    Chart.helpers.each(Chart.instances, function(chart){
      if (chart.options.scales) {
        Object.values(chart.options.scales).forEach(function(s){
          s.grid = s.grid || {};
          s.grid.color = gridColor;
          s.ticks = s.ticks || {};
          s.ticks.color = tickColor;
        });
      }
      if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = tickColor;
      chart.update();
    });
  }
  updateChartColors();
})();
</script>

</body>
</html>`;
}

// --- Main ---
const args = parseArgs();
const dateFile = args.date || formatDate(new Date());
const dataPath = path.join(DATA_DIR, `${dateFile}.json`);

if (!existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  console.error(`Run 'node scripts/fetch.js' first.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataPath, "utf-8"));

// Try to load AI analysis
const analysisPath = path.join(DATA_DIR, `${dateFile}-analysis.json`);
let aiAnalysis = null;
if (existsSync(analysisPath)) {
  try {
    aiAnalysis = JSON.parse(readFileSync(analysisPath, "utf-8"))?.analysis || null;
    console.log(`AI analysis loaded from ${dateFile}-analysis.json`);
  } catch (e) {
    console.error(`Failed to parse AI analysis: ${e.message}`);
  }
} else {
  console.log(`No AI analysis file found (${dateFile}-analysis.json), using rule-engine fallback`);
}

const html = generateHTML(data, aiAnalysis);

mkdirSync(REPORT_DIR, { recursive: true });
const outPath = path.join(REPORT_DIR, `${dateFile}-report.html`);
writeFileSync(outPath, html, "utf-8");
console.log(`Report saved to ${outPath}`);
