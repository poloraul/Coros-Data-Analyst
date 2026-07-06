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

function loadAnalysis(date) {
  const p = path.join(DATA_DIR, `${date}${ANALYSIS_PREFIX}`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = dateStr.length === 8 ? dateStr : dateStr.replace(/-/g, "").slice(0, 8);
  const y = d.slice(0, 4), m = d.slice(4, 6), day = d.slice(6, 8);
  const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(`${y}-${m}-${day}`).getDay()];
  return `${m}月${day}日 · 周${wd}`;
}

function dayOfWeek(dateStr) {
  const d = dateStr.length === 8 ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}` : dateStr;
  return new Date(d).getDay();
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
  const profile = ctx.profile || {};
  const goal = ctx.goal || {};
  const workouts = ctx.workouts || [];
  const weeklyPlan = a.weeklyPlan || [];
  const bodyLevel = a.bodyAssessment?.overallLevel || null;
  const patternSummary = a.trainingPatternAnalysis?.summary || null;

  // Running workouts only (filter out strength, walking)
  const runs = workouts.filter(w => w.distance > 0 && w.avgPace && w.avgPace !== "15:00");

  // Weekly total from weeklyPlan (planned) + completed from runs
  const totalKm = runs.reduce((s, w) => s + (w.distance || 0), 0);
  const runCount = runs.length;

  // Planned total = sum of weeklyPlan totalDistance
  const planKm = weeklyPlan.reduce((s, d) => s + (d.totalDistance || 0), 0);

  return {
    date,
    fmtDate: fmtDate(date),
    bodyLevel,
    phase: `${goal.currentPhase || ""}${goal.currentWeek ? " W" + goal.currentWeek : ""}`,
    weeksLeft: goal.weeksLeft,
    totalKm,
    runCount,
    planKm,
    runs,
    patternSummary,
    hasReport: existsSync(path.join(REPORT_DIR, `${date}${REPORT_PREFIX}`)),
  };
}).filter(Boolean);

const totalReports = reports.length;
const totalKm = reports.reduce((s, r) => s + r.totalKm, 0);
const avgWeeklyKm = totalReports > 0 ? (totalKm / totalReports).toFixed(1) : "0";

// Build HTML
const levelColors = { green: "#7ec882", yellow: "#f4c542", red: "#e89898" };
const levelLabels = { green: "良好", yellow: "注意", red: "警告" };

function cardStyle(color) {
  return color ? `style="border-left:4px solid ${color}"` : "";
}

let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>训练复盘报告列表</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#faf6ef;--card:#fff;--border:#e8dfd3;--text:#5a5247;--text-strong:#4a4238;--muted:#9e9484;--accent:#7ec882;--accent2:#f4c542;--accent3:#e89898;--accent4:#7cb9e8;--shadow:rgba(90,82,71,.05);--row-hover:rgba(126,200,130,.04)}
[data-theme="dark"]{--bg:#1a1b26;--card:#24283b;--border:#3b4261;--text:#a9b1d6;--text-strong:#c0caf5;--muted:#565f89;--accent:#9ece6a;--accent2:#e0af68;--accent3:#f7768e;--accent4:#7aa2f7;--shadow:rgba(0,0,0,.2);--row-hover:rgba(158,206,106,.06)}
body{font-family:'Hiragino Sans','Yu Gothic',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:24px;max-width:1100px;margin:0 auto}
h1{font-size:1.6rem;font-weight:800;color:var(--accent);margin-bottom:4px}
.subtitle{color:var(--muted);font-size:.85rem;margin-bottom:24px}
.stats-bar{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 20px;flex:1;min-width:130px;box-shadow:0 2px 6px var(--shadow)}
.stat-card .label{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.stat-card .value{font-size:1.4rem;font-weight:700;color:var(--text-strong);margin-top:2px}
.stat-card .sub{font-size:.7rem;color:var(--muted);margin-top:1px}

.report-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:12px;box-shadow:0 2px 6px var(--shadow);transition:border-color .2s,background .2s;display:flex;align-items:center;gap:16px}
.report-card:hover{border-color:var(--accent);background:var(--row-hover)}
.report-card .date-col{min-width:130px}
.report-card .date-col .day{font-size:1.1rem;font-weight:700;color:var(--text-strong)}
.report-card .date-col .date-sub{font-size:.72rem;color:var(--muted)}
.report-card .info-col{flex:1;min-width:0}
.report-card .info-col .phase{font-size:.78rem;color:var(--muted)}
.report-card .info-col .summary{font-size:.8rem;color:var(--text);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.report-card .info-col .runs-wrap{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.report-card .stats-col{text-align:right;min-width:100px;flex-shrink:0}
.report-card .stats-col .km{font-size:1.1rem;font-weight:700;color:var(--accent)}
.report-card .stats-col .runs{font-size:.7rem;color:var(--muted)}
.report-card .open-link{display:inline-block;margin-top:4px;color:var(--accent4);font-size:.75rem;text-decoration:none}
.report-card .open-link:hover{text-decoration:underline}
.badge{display:inline-block;padding:1px 7px;border-radius:6px;font-size:.7rem;font-weight:500}
.badge-run{background:rgba(122,162,247,.12);color:var(--accent4)}
.no-reports{text-align:center;padding:60px 20px;color:var(--muted);font-size:.9rem}
.header-row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
.theme-toggle{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:6px 10px;cursor:pointer;font-size:1.1rem;line-height:1;color:var(--muted);transition:background .3s,border-color .3s}
.theme-toggle:hover{color:var(--text-strong);border-color:var(--accent)}
@media(max-width:768px){body{padding:14px}h1{font-size:1.3rem}.subtitle{font-size:.78rem;margin-bottom:18px}.stats-bar{gap:10px;margin-bottom:20px}.stat-card{padding:10px 14px;min-width:100px}.stat-card .value{font-size:1.15rem}.report-card{padding:12px 14px;gap:10px}.report-card .date-col{min-width:80px}.report-card .date-col .day{font-size:.95rem}.report-card .stats-col{min-width:70px}.report-card .stats-col .km{font-size:.95rem}.report-card .info-col .summary{font-size:.75rem}.header-row{flex-wrap:wrap;gap:10px}}
@media(max-width:480px){body{padding:10px}h1{font-size:1.1rem}.subtitle{font-size:.72rem;margin-bottom:16px}.stat-card{padding:8px 10px;min-width:80px}.stat-card .value{font-size:1rem}.report-card{flex-wrap:wrap;gap:6px;padding:10px 12px}.report-card .date-col{min-width:auto}.report-card .stats-col{text-align:left;min-width:auto}}
</style>
</head>
<body>

<div class="header-row">
  <div>
    <h1>🏃 训练复盘报告</h1>
    <p class="subtitle">共 ${totalReports} 份报告 · 累计跑量 ${totalKm.toFixed(0)}km · 周均 ${avgWeeklyKm}km</p>
  </div>
  <button class="theme-toggle" id="themeToggle" title="切换主题">🌙</button>
</div>

<div class="stats-bar">
  <div class="stat-card"><div class="label">报告总数</div><div class="value">${totalReports}</div><div class="sub"></div></div>
  <div class="stat-card"><div class="label">累计跑量</div><div class="value">${totalKm.toFixed(0)}<span style="font-size:.9rem">km</span></div><div class="sub"></div></div>
  <div class="stat-card"><div class="label">周均跑量</div><div class="value">${avgWeeklyKm}<span style="font-size:.9rem">km</span></div><div class="sub"></div></div>
  <div class="stat-card"><div class="label">最近报告</div><div class="value" style="font-size:.95rem">${reports[0]?.fmtDate || "—"}</div><div class="sub"></div></div>
</div>

${reports.map(r => {
  const dw = new Date(`${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}`).getDay();
  const dwName = ["日", "一", "二", "三", "四", "五", "六"][dw];
  const monthDay = `${r.date.slice(4,6)}/${r.date.slice(6,8)}`;
  const borderColor = r.bodyLevel ? levelColors[r.bodyLevel] : "transparent";
  const bodyLabel = r.bodyLevel ? levelLabels[r.bodyLevel] : "";

  // Training type badges
  const typeBadges = r.runs.slice(0, 5).map(w => {
    const type = w.tcxSummary ? w.tcxSummary.split(";")[0].replace(/\(.*\)/, "").trim() : "";
    const label = type.slice(0, 6) || "跑";
    return `<span class="badge badge-run">${label}</span>`;
  }).join("");

  return `<a href="${r.date}${REPORT_PREFIX}" style="text-decoration:none;color:inherit">
<div class="report-card" ${cardStyle(borderColor)}>
  <div class="date-col">
    <div class="day">${monthDay}</div>
    <div class="date-sub">周${dwName} · ${r.date.slice(0,4)}</div>
    ${r.bodyLevel ? `<span class="badge" style="background:${borderColor}22;color:${borderColor};margin-top:4px">${bodyLabel}</span>` : ""}
  </div>
  <div class="info-col">
    <div class="phase">${r.phase || ""}${r.weeksLeft ? ` · 距首马 ${r.weeksLeft} 周` : ""}</div>
    ${r.patternSummary ? `<div class="summary">${r.patternSummary.slice(0, 90)}${r.patternSummary.length > 90 ? "…" : ""}</div>` : ""}
    <div class="runs-wrap">${typeBadges} ${r.runs.length > 5 ? `<span class="badge badge-run">+${r.runs.length - 5}</span>` : ""}</div>
  </div>
  <div class="stats-col">
    <div class="km">${r.totalKm.toFixed(1)}<span style="font-size:.7rem;font-weight:400">km</span></div>
    <div class="runs">${r.runCount} 次跑步${r.planKm > 0 ? ` · 计划 ${r.planKm}km` : ""}</div>
  </div>
</div>
</a>`;
}).join("\n")}

<script>
// Theme toggle (matches individual report style)
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
console.log(`  ${reports.length} reports indexed`);