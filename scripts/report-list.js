#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");
const REPORT_DIR = path.join(PROJECT_ROOT, "reports");
const REPORT_PREFIX = "-report.html";
const ANALYSIS_PREFIX = "-analysis.json";
const MARATHON_DATE = "2026-12-06";
const TARGET_TIME = "3:30:00";

function loadAnalysis(date) {
  const p = path.join(DATA_DIR, `${date}${ANALYSIS_PREFIX}`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// Collect all report dates
const allFiles = readdirSync(DATA_DIR);
const dates = allFiles
  .filter(f => f.endsWith(ANALYSIS_PREFIX))
  .map(f => f.replace(ANALYSIS_PREFIX, ""))
  .filter(d => /^\d{8}$/.test(d))
  .sort((a, b) => b.localeCompare(a));

const reports = dates.map(date => {
  const analysis = loadAnalysis(date);
  if (!analysis) return null;
  const ctx = analysis.context || {};
  const a = analysis.analysis || {};
  const goal = ctx.goal || {};
  const workouts = ctx.workouts || [];
  const weeklyPlan = a.weeklyPlan || [];
  const bodyLevel = a.bodyAssessment?.overallLevel || null;
  const patternSummary = a.trainingPatternAnalysis?.summary || null;

  const runs = workouts.filter(w => w.distance > 0);
  const totalKm = runs.reduce((s, w) => s + (w.distance || 0), 0);
  const runCount = runs.length;
  const planKm = weeklyPlan.reduce((s, d) => s + (d.totalDistance || 0), 0);

  return {
    date,
    bodyLevel,
    phase: `${goal.currentPhase || ""}${goal.currentWeek ? " W" + goal.currentWeek : ""}`,
    weeksLeft: goal.weeksLeft,
    totalKm, runCount, planKm,
    runs,
    patternSummary,
    hasReport: existsSync(path.join(REPORT_DIR, `${date}${REPORT_PREFIX}`)),
  };
}).filter(Boolean);

const totalReports = reports.length;
const totalKm = reports.reduce((s, r) => s + r.totalKm, 0);
const avgWeeklyKm = totalReports > 0 ? (totalKm / totalReports).toFixed(1) : "0";

// --- Computed stats ---
const latest = reports[0] || null;
const latestRun = latest?.runs?.[0] || null;
const currentPhase = latest?.phase || "";
const weeksLeft = latest?.weeksLeft || 0;
const totalWeeks = 24;
const weeksDone = totalWeeks - weeksLeft;
const weeksPct = Math.min(100, Math.round((weeksDone / totalWeeks) * 100));

// Mileage milestones
const KM_MILESTONES = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500];
const nextMilestone = KM_MILESTONES.find(m => m > totalKm) || null;
const milestonePct = nextMilestone ? Math.round((totalKm / nextMilestone) * 100) : 100;
const mileStonesAchieved = KM_MILESTONES.filter(m => m <= totalKm);

// Best week (highest weekly km among reports)
const bestWeek = [...reports].sort((a, b) => b.totalKm - a.totalKm)[0];

// Longest single run
const allRuns = reports.flatMap(r => r.runs);
const longestRun = [...allRuns].sort((a, b) => (b.distance || 0) - (a.distance || 0))[0];

// Running streak: count consecutive weeks with reports
let streak = 0;
for (const r of reports) {
  if (r.totalKm > 0) streak++;
  else break;
}

// Last 7 days distance
const last7Km = reports.length >= 7
  ? reports.slice(0, 7).reduce((s, r) => s + r.totalKm, 0)
  : reports.reduce((s, r) => s + r.totalKm, 0);

// --- Group by month for timeline ---
function monthKey(dateStr) {
  return dateStr.slice(0, 6); // YYYYMM
}
const groups = {};
for (const r of reports) {
  const mk = monthKey(r.date);
  if (!groups[mk]) groups[mk] = [];
  groups[mk].push(r);
}
const monthLabels = {
  "01": "一月", "02": "二月", "03": "三月", "04": "四月",
  "05": "五月", "06": "六月", "07": "七月", "08": "八月",
  "09": "九月", "10": "十月", "11": "十一月", "12": "十二月",
};
function fmtMonthGroup(mk) {
  const y = mk.slice(0, 4);
  const m = monthLabels[mk.slice(4, 6)] || mk.slice(4, 6);
  return `${y}年 ${m}`;
}

// --- HTML ---
const levelColors = { green: "#7ec882", yellow: "#f4c542", red: "#e89898" };
const levelLabels = { green: "良好", yellow: "注意", red: "警告" };

// Helper: format date for display
function fmtShortDate(dateStr) {
  return `${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
}

// Helper: day name
function dayName(dateStr) {
  const d = new Date(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`);
  return ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
}

// Escape HTML in patternSummary for safety (it may contain user-facing text)
function escHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Training pace trend labels for badges
function trendBadge(run) {
  if (!run?.tcxSummary) return "跑";
  const firstSeg = run.tcxSummary.split(";")[0].trim();
  if (firstSeg.includes("负分段加速")) return "负分段";
  if (firstSeg.includes("后程掉速")) return "掉速";
  if (firstSeg.includes("配速均匀") || firstSeg.includes("配速波动")) return "匀速";
  return firstSeg.length > 6 ? firstSeg.slice(0, 6) : firstSeg;
}

let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jarvis 的 3:30 马拉松训练日志</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#faf6ef;--card:#fff;--border:#e8dfd3;--text:#5a5247;--text-strong:#4a4238;--muted:#9e9484;--accent:#7ec882;--accent2:#f4c542;--accent3:#e89898;--accent4:#7cb9e8;--shadow:rgba(90,82,71,.06);--row-hover:rgba(126,200,130,.04);--hero-glow:rgba(126,200,130,.08);--milestone-bg:rgba(126,200,130,.06)}
[data-theme="dark"]{--bg:#0f111a;--card:#1a1b26;--border:#2f3346;--text:#a9b1d6;--text-strong:#c0caf5;--muted:#565f89;--accent:#9ece6a;--accent2:#e0af68;--accent3:#f7768e;--accent4:#7aa2f7;--shadow:rgba(0,0,0,.3);--row-hover:rgba(158,206,106,.05);--hero-glow:rgba(158,206,106,.05);--milestone-bg:rgba(158,206,106,.06)}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Hiragino Sans','Yu Gothic',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:0;min-height:100vh;transition:background .3s,color .3s}

/* Header */
.header{background:var(--card);border-bottom:1px solid var(--border);padding:28px 24px 20px;position:relative;overflow:hidden}
.header::before{content:'';position:absolute;top:-60%;right:-20%;width:400px;height:400px;background:radial-gradient(circle,var(--hero-glow) 0%,transparent 70%);pointer-events:none}
.header-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:space-between;align-items:flex-start;position:relative}
.header-left{flex:1}
.header-title{font-size:1.5rem;font-weight:800;margin-bottom:2px}
.header-title .gradient{background:linear-gradient(135deg,var(--accent),var(--accent4));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header-sub{color:var(--muted);font-size:.82rem}
.theme-toggle{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:6px 10px;cursor:pointer;font-size:1.1rem;line-height:1;color:var(--muted);transition:all .3s;flex-shrink:0;margin-left:12px}
.theme-toggle:hover{color:var(--text-strong);border-color:var(--accent);transform:rotate(15deg)}

/* Hero stat cards */
.hero-row{max-width:1100px;margin:0 auto;padding:20px 24px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.hero-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px 20px;box-shadow:0 2px 8px var(--shadow);transition:transform .2s,box-shadow .2s}
.hero-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px var(--shadow)}
.hero-card .icon{font-size:1.3rem;margin-bottom:4px}
.hero-card .value{font-size:1.5rem;font-weight:800;color:var(--text-strong);line-height:1.2}
.hero-card .value .unit{font-size:.8rem;font-weight:400;color:var(--muted)}
.hero-card .label{font-size:.75rem;color:var(--muted);margin-top:2px}
.hero-card.accent .value{background:linear-gradient(135deg,var(--accent),var(--accent4));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}

/* Training plan progress bar */
.progress-section{max-width:1100px;margin:0 auto;padding:16px 24px 0}
.progress-bar-wrap{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 20px;box-shadow:0 2px 8px var(--shadow);display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.progress-bar-label{font-size:.78rem;color:var(--muted);white-space:nowrap}
.progress-bar-track{flex:1;min-width:120px;height:8px;background:var(--border);border-radius:4px;overflow:hidden}
.progress-bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--accent4));transition:width .8s ease}
.progress-bar-info{font-size:.75rem;color:var(--muted);white-space:nowrap}

/* Milestone strip */
.milestone-strip{max-width:1100px;margin:0 auto;padding:12px 24px 0;display:flex;flex-wrap:wrap;gap:8px}
.milestone-badge{display:inline-flex;align-items:center;gap:4px;background:var(--milestone-bg);border:1px solid transparent;border-radius:20px;padding:4px 12px;font-size:.75rem;color:var(--accent);font-weight:500}
.milestone-badge.next{border-color:var(--border);color:var(--muted);background:transparent}
.milestone-badge .pct{font-size:.65rem;color:var(--muted);font-weight:400}

/* Latest training snapshot */
.latest-section{max-width:1100px;margin:0 auto;padding:20px 24px 0}
.latest-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:0 2px 8px var(--shadow);display:grid;grid-template-columns:1fr 1fr;gap:16px}
.latest-card .lc-left{display:flex;flex-direction:column;gap:6px}
.latest-card .lc-left .lc-title{font-size:.78rem;color:var(--muted);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.latest-card .lc-left .lc-date{font-size:1.2rem;font-weight:700;color:var(--text-strong)}
.latest-card .lc-left .lc-date .dow{font-size:.8rem;font-weight:400;color:var(--muted)}
.latest-card .lc-metrics{display:flex;gap:16px;flex-wrap:wrap}
.latest-card .lc-metric{text-align:center}
.latest-card .lc-metric .lc-mv{font-size:1.1rem;font-weight:700;color:var(--text-strong)}
.latest-card .lc-metric .lc-ml{font-size:.68rem;color:var(--muted)}
.latest-card .lc-right{display:flex;flex-direction:column;gap:8px;justify-content:center}
.latest-card .lc-tag{display:inline-block;background:rgba(122,162,247,.1);color:var(--accent4);padding:3px 10px;border-radius:8px;font-size:.75rem;font-weight:500}
.latest-card .lc-week-progress{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:.78rem;color:var(--muted)}
.latest-card .lc-week-bar{flex:1;min-width:80px;height:6px;background:var(--border);border-radius:3px;overflow:hidden}
.latest-card .lc-week-fill{height:100%;border-radius:3px;background:var(--accent);transition:width .6s}
.latest-card .lc-link{display:inline-flex;align-items:center;gap:4px;margin-top:2px;font-size:.78rem;color:var(--accent4);text-decoration:none;font-weight:500}
.latest-card .lc-link:hover{text-decoration:underline}

/* Section title */
.section-wrap{max-width:1100px;margin:0 auto;padding:24px 24px 0}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.section-head .sh-line{flex:1;height:1px;background:var(--border)}
.section-head .sh-text{font-size:.78rem;font-weight:600;color:var(--muted);letter-spacing:.4px;text-transform:uppercase;white-space:nowrap}
.section-head .sh-count{font-size:.7rem;color:var(--muted);font-weight:400}

/* Timeline report cards */
.timeline{max-width:1100px;margin:0 auto;padding:0 24px 40px}
.tl-month{position:relative;padding-left:20px;margin-bottom:8px}
.tl-month::before{content:'';position:absolute;left:6px;top:14px;bottom:-8px;width:2px;background:var(--border);border-radius:1px}
.tl-month:last-child::before{display:none}
.tl-month-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;padding:6px 0}
.tl-month-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);border:2px solid var(--card);flex-shrink:0;margin-left:-25px}
.tl-month-label{font-size:.8rem;font-weight:600;color:var(--muted)}

.tl-card{display:flex;align-items:center;gap:12px;padding:10px 14px;margin-bottom:4px;background:var(--card);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:all .2s;text-decoration:none;color:inherit}
.tl-card:hover{border-color:var(--accent);box-shadow:0 3px 12px var(--shadow);transform:translateX(3px)}
.tl-card .tl-date{min-width:56px}
.tl-card .tl-date .tl-day{font-size:1rem;font-weight:700;color:var(--text-strong);line-height:1.2}
.tl-card .tl-date .tl-dow{font-size:.65rem;color:var(--muted)}
.tl-card .tl-body{flex:1;min-width:0}
.tl-card .tl-body .tl-phase{font-size:.68rem;color:var(--muted)}
.tl-card .tl-body .tl-summary{font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.tl-card .tl-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
.tl-card .tl-stats{text-align:right;flex-shrink:0;min-width:60px}
.tl-card .tl-stats .tl-km{font-size:.95rem;font-weight:700;color:var(--accent)}
.tl-card .tl-stats .tl-runs{font-size:.65rem;color:var(--muted)}

.tl-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-left:-18px}
.tl-status-dot.dot-green{background:#7ec882;box-shadow:0 0 6px rgba(126,200,130,.5)}
.tl-status-dot.dot-yellow{background:#f4c542;box-shadow:0 0 6px rgba(244,197,66,.5)}
.tl-status-dot.dot-red{background:#e89898;box-shadow:0 0 6px rgba(232,152,152,.5)}

/* Tags */
.tag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:.65rem;font-weight:500;background:rgba(122,162,247,.1);color:var(--accent4)}

/* Content area max-width contrainer */
.content-wrap{max-width:1100px;margin:0 auto;padding:0 24px}

/* Responsive */
@media(max-width:768px){
  .header{padding:20px 16px 16px}
  .header-title{font-size:1.2rem}
  .header-inner{padding:0}
  .hero-row{grid-template-columns:repeat(2,1fr);gap:10px;padding:16px 16px 0}
  .hero-card{padding:14px 16px}
  .hero-card .value{font-size:1.2rem}
  .latest-card{grid-template-columns:1fr;gap:12px}
  .latest-section,.progress-section,.milestone-strip,.section-wrap,.timeline,.content-wrap{padding-left:16px;padding-right:16px}
  .progress-bar-wrap{flex-wrap:wrap;gap:10px}
  .tl-card{gap:8px;padding:8px 10px}
  .tl-card .tl-date{min-width:44px}
  .tl-card .tl-date .tl-day{font-size:.85rem}
  .tl-card .tl-stats{min-width:50px}
  .tl-card .tl-stats .tl-km{font-size:.82rem}
  .tl-card .tl-body .tl-summary{font-size:.72rem}
  .tl-month{padding-left:16px}
  .tl-status-dot{margin-left:-14px;width:6px;height:6px}
  .tl-month-dot{margin-left:-21px;width:8px;height:8px}
}
@media(max-width:480px){
  .hero-row{grid-template-columns:1fr 1fr;gap:8px}
  .header-title{font-size:1rem}
  .hero-card{padding:10px 12px}
  .hero-card .value{font-size:1rem}
  .latest-card{padding:14px}
  .latest-card .lc-metrics{gap:10px}
  .latest-card .lc-metric .lc-mv{font-size:.95rem}
  .tl-month{padding-left:14px}
  .tl-status-dot{margin-left:-11px}
  .tl-month-dot{margin-left:-18px}
}
</style>
</head>
<body>

<!-- ==================== Hero ==================== -->
<div class="header">
  <div class="header-inner">
    <div class="header-left">
      <div class="header-title"><span class="gradient">Jarvis 的 3:30 马拉松训练日志</span></div>
      <div class="header-sub">距首马 ${weeksLeft} 周 · ${MARATHON_DATE} · 目标配速 4:58/km</div>
    </div>
    <button class="theme-toggle" id="themeToggle" title="切换主题">🌙</button>
  </div>
</div>

<div class="hero-row">
  <div class="hero-card accent">
    <div class="icon">⏱️</div>
    <div class="value">${weeksLeft}<span class="unit"> 周</span></div>
    <div class="label">距首马 ${MARATHON_DATE}</div>
  </div>
  <div class="hero-card accent">
    <div class="icon">📏</div>
    <div class="value">${(totalKm / 1000).toFixed(1)}<span class="unit">k km</span></div>
    <div class="label">累计跑量 · ${totalReports} 份报告</div>
  </div>
  <div class="hero-card">
    <div class="icon">🎯</div>
    <div class="value">${currentPhase}</div>
    <div class="label">当前阶段 ${weeksDone}/${totalWeeks} 周</div>
  </div>
</div>

<!-- Training Plan Progress -->
<div class="progress-section">
  <div class="progress-bar-wrap">
    <span class="progress-bar-label">📅 训练进度</span>
    <div class="progress-bar-track">
      <div class="progress-bar-fill" style="width:${weeksPct}%"></div>
    </div>
    <span class="progress-bar-info">${weeksDone} / ${totalWeeks} 周 · ${weeksPct}%</span>
  </div>
</div>

<!-- Milestones -->`;

// Build milestone badges — show only recent achieved + next goal + highlights
const mileHtml = [];
// Latest achieved milestone: biggest one <= totalKm
const achievedLast = [...KM_MILESTONES].reverse().find(m => m <= totalKm);
if (achievedLast && achievedLast >= 500) {
  mileHtml.push(`<span class="milestone-badge">🎉 ${achievedLast}km 达成</span>`);
}
// Next milestone with progress
if (nextMilestone) {
  mileHtml.push(`<span class="milestone-badge next">🏁 ${nextMilestone}km <span class="pct">${milestonePct}%</span></span>`);
}
if (bestWeek) {
  mileHtml.push(`<span class="milestone-badge">🔥 最佳周 ${bestWeek.totalKm.toFixed(0)}km</span>`);
}
if (longestRun) {
  mileHtml.push(`<span class="milestone-badge">💪 最远 ${longestRun.distance.toFixed(1)}km</span>`);
}

html += `<div class="milestone-strip">${mileHtml.join("")}</div>`;

// Latest training snapshot
if (latest && latestRun) {
  const dow = dayName(latest.date);
  const weekKm = latest.totalKm;
  const planWeekKm = latest.planKm;
  const weekPct = planWeekKm > 0 ? Math.min(100, Math.round((weekKm / planWeekKm) * 100)) : 0;
  const trend = trendBadge(latestRun);
  const latestDate = fmtShortDate(latest.date);

  html += `
<div class="latest-section">
  <div class="latest-card">
    <div class="lc-left">
      <div class="lc-title">📋 最近训练</div>
      <div class="lc-date">${latest.date.slice(0,4)}/${latestDate} <span class="dow">· 周${dow}</span></div>
      <div class="lc-metrics">
        <div class="lc-metric"><div class="lc-mv">${latestRun.distance?.toFixed(2) || "-"}<span style="font-size:.65rem;font-weight:400">km</span></div><div class="lc-ml">距离</div></div>
        <div class="lc-metric"><div class="lc-mv">${latestRun.avgPace || "-"}</div><div class="lc-ml">配速</div></div>
        <div class="lc-metric"><div class="lc-mv">${latestRun.avgHR || "-"}</div><div class="lc-ml">心率</div></div>
        ${latestRun.avgPower ? `<div class="lc-metric"><div class="lc-mv">${latestRun.avgPower}<span style="font-size:.65rem;font-weight:400">W</span></div><div class="lc-ml">功率</div></div>` : ""}
      </div>
    </div>
    <div class="lc-right">
      <div><span class="lc-tag">${trend}</span>${latest.bodyLevel ? ` <span class="tag" style="background:${levelColors[latest.bodyLevel]}22;color:${levelColors[latest.bodyLevel]}">${levelLabels[latest.bodyLevel]}</span>` : ""}${latest.phase ? ` <span class="tag" style="background:rgba(78,106,166,.12);color:var(--muted)">${latest.phase}</span>` : ""}</div>
      <div class="lc-week-progress">本周 ${weekKm.toFixed(1)}km / ${planWeekKm}km<div class="lc-week-bar"><div class="lc-week-fill" style="width:${weekPct}%"></div></div></div>
      <a href="${latest.date}${REPORT_PREFIX}" class="lc-link">查看完整报告 →</a>
    </div>
  </div>
</div>`;
}

// Timeline
html += `
<div class="section-wrap">
  <div class="section-head">
    <span class="sh-text">训练日志</span>
    <span class="sh-count">· ${totalReports} 篇</span>
    <span class="sh-line"></span>
  </div>
</div>

<div class="timeline">`;

const monthKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
for (const mk of monthKeys) {
  const monthReports = groups[mk];
  const monthTotal = monthReports.reduce((s, r) => s + r.totalKm, 0);
  const monthRuns = monthReports.reduce((s, r) => s + r.runCount, 0);

  html += `
  <div class="tl-month">
    <div class="tl-month-header">
      <div class="tl-month-dot"></div>
      <span class="tl-month-label">${fmtMonthGroup(mk)}</span>
      <span style="font-size:.7rem;color:var(--muted)">· ${monthTotal.toFixed(0)}km · ${monthRuns} 次</span>
    </div>`;

  for (const r of monthReports) {
    const dow = dayName(r.date);
    const borderColor = r.bodyLevel ? levelColors[r.bodyLevel] : "transparent";
    const dotClass = r.bodyLevel ? `dot-${r.bodyLevel}` : "";
    const firstRun = r.runs[0];
    const trends = r.runs.slice(0, 4).map(wd => trendBadge(wd));
    const uniqueTrends = [...new Set(trends)].slice(0, 3);

    html += `
    <a href="${r.date}${REPORT_PREFIX}" class="tl-card">
      <div class="tl-status-dot ${dotClass}" style="${r.bodyLevel ? '' : 'background:var(--border);box-shadow:none'}"></div>
      <div class="tl-date">
        <div class="tl-day">${fmtShortDate(r.date)}</div>
        <div class="tl-dow">周${dow}</div>
      </div>
      <div class="tl-body">
        ${r.phase ? `<div class="tl-phase">${r.phase}</div>` : ""}
        ${r.patternSummary ? `<div class="tl-summary">${escHtml(r.patternSummary.slice(0, 70))}${r.patternSummary.length > 70 ? "…" : ""}</div>` : ""}
        <div class="tl-tags">${uniqueTrends.map(t => `<span class="tag">${t}</span>`).join("")}</div>
      </div>
      <div class="tl-stats">
        <div class="tl-km">${r.totalKm.toFixed(1)}</div>
        <div class="tl-runs">${r.runCount} 次</div>
      </div>
    </a>`;
  }

  html += `</div>`;
}

html += `</div>`;

// Footer
html += `
<div style="max-width:1100px;margin:0 auto;padding:10px 24px 40px;text-align:center;font-size:.72rem;color:var(--muted)">
  <p>Jarvis · 首马目标 3:30 · 2026.12.06 · ${MARATHON_DATE}</p>
</div>

<script>
(function(){
  const btn = document.getElementById('themeToggle');
  const root = document.documentElement;
  const saved = localStorage.getItem('coros-theme') || 'dark';
  root.setAttribute('data-theme', saved);
  btn.textContent = saved === 'dark' ? '☀️' : '🌙';
  btn.addEventListener('click', function(){
    const isDark = root.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    btn.textContent = next === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('coros-theme', next);
  });
})();
</script>
</body>
</html>`;

mkdirSync(REPORT_DIR, { recursive: true });
const outPath = path.join(REPORT_DIR, "index.html");
writeFileSync(outPath, html, "utf-8");
console.log(`Report list saved to ${path.relative(PROJECT_ROOT, outPath)}`);
console.log(`  ${reports.length} reports indexed, ${totalKm.toFixed(0)}km total`);
