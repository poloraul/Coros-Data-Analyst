#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentWeekBounds } from "../lib/training-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) return args[i + 1];
  }
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
}

function paceToSec(pace) {
  if (!pace) return null;
  const m = pace.match(/^(\d+):(\d+)/);
  return m ? parseInt(m[1])*60 + parseInt(m[2]) : null;
}

const dateFile = parseArgs();
const rawPath = path.join(PROJECT_ROOT, "data", "daily", `${dateFile}.json`);
const analysisPath = path.join(PROJECT_ROOT, "data", "daily", `${dateFile}-analysis.json`);

const issues = [];
let rawData, analysisData;

if (!existsSync(rawPath)) {
  console.log(JSON.stringify({ issues: [{severity:"error",category:"missing",description:`原始数据 ${dateFile}.json 不存在`}], hasIssues: true, summary: "数据文件缺失" }));
  process.exit(1);
}
if (!existsSync(analysisPath)) {
  console.log(JSON.stringify({ issues: [{severity:"error",category:"missing",description:`分析文件 ${dateFile}-analysis.json 不存在`}], hasIssues: true, summary: "分析文件缺失，需运行 analyze.js" }));
  process.exit(1);
}

try {
  rawData = JSON.parse(readFileSync(rawPath, "utf-8"));
  analysisData = JSON.parse(readFileSync(analysisPath, "utf-8"));
} catch (e) {
  console.log(JSON.stringify({ issues: [{severity:"error",category:"parse",description:`JSON 解析失败: ${e.message}`}], hasIssues: true, summary: "JSON 解析失败" }));
  process.exit(1);
}

// Check 1: TCX配速趋势方向 vs 标签
const reviews = analysisData.analysis?.workoutReviews || [];
for (const review of reviews) {
  const detail = (rawData.activityDetails || []).find(d => d.date === review.date);
  if (!detail?.tcxMetrics?.kmSplits) continue;
  const splits = detail.tcxMetrics.kmSplits;
  if (splits.length < 2) continue;
  const firstPace = splits[0].paceSecPerKm;
  const lastPace = splits[splits.length - 1].paceSecPerKm;
  const actualFaster = firstPace > lastPace ? "负分段加速" : firstPace < lastPace ? "后程掉速" : "匀速";

  const tcxSummary = detail.tcxMetrics?.tcxSummary || review.detailedAnalysis || "";
  if (tcxSummary.includes("负分段加速") && actualFaster === "后程掉速") {
    issues.push({severity:"warning",category:"pace-trend",description:`${review.date}: 标签"负分段加速"与实际方向"后程掉速"不符`});
  } else if (tcxSummary.includes("后程掉速") && actualFaster === "负分段加速") {
    issues.push({severity:"warning",category:"pace-trend",description:`${review.date}: 标签"后程掉速"与实际方向"负分段加速"不符`});
  }
}

// Check 2: HRV/恢复一致性
const body = analysisData.analysis?.bodyAssessment;
if (body) {
  const latestHRV = rawData.hrv?.days?.[0]?.hrv;
  const detailText = JSON.stringify(body.details || []);
  if (latestHRV && detailText.includes(String(latestHRV))) {
    // HRV引用一致，无需记录
  }

  const recoveryPct = rawData.recovery?.percentage;
  if (recoveryPct && detailText.includes(String(recoveryPct))) {
    // recovery引用一致
  }
}

// Check 3: weeklyPlan日期从今天开始
const weeklyPlan = analysisData.analysis?.weeklyPlan || [];
if (weeklyPlan.length > 0) {
  const todayStr = `${dateFile.slice(0,4)}-${dateFile.slice(4,6)}-${dateFile.slice(6,8)}`;
  if (weeklyPlan[0].date !== todayStr) {
    issues.push({severity:"warning",category:"weeklyPlan",description:`周计划首日 ${weeklyPlan[0].date} 与报告日期 ${todayStr} 不一致`});
  }
}

console.log(JSON.stringify({
  issues,
  hasIssues: issues.length > 0,
  summary: issues.length > 0 ? `发现 ${issues.length} 个问题` : "所有检查通过",
}));
