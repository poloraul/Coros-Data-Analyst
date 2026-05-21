#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");
const ISSUER = "https://mcpus.coros.com";
const TIMEZONE = "Asia/Shanghai";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { date: null, full: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) parsed.date = args[++i];
    if (args[i] === "--full") parsed.full = true;
  }
  return parsed;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function callTool(toolName, args) {
  const argsJson = JSON.stringify(args);
  const escaped = argsJson.replace(/'/g, "'\\''");
  const cmd = `coros-mcp --issuer ${ISSUER} call-tool --tool ${toolName} --arguments-json '${escaped}'`;
  try {
    const stdout = execSync(cmd, { encoding: "utf-8", timeout: 30000 });
    const result = JSON.parse(stdout.trim());
    if (result.isError) {
      console.error(`  [WARN] ${toolName} returned error`);
      return null;
    }
    if (result.content?.[0]?.text) {
      let text = result.content[0].text;
      if (text.startsWith('"') && text.endsWith('"')) {
        try { text = JSON.parse(text); } catch { /* keep as-is */ }
      }
      return text;
    }
    return null;
  } catch (e) {
    console.error(`  [WARN] ${toolName} failed: ${e.message}`);
    return null;
  }
}

// --- Parsers ---

function parseSportRecords(text) {
  if (!text) return [];
  const records = [];
  const blocks = text.split(/\n(?=\d+\.\s)/);
  for (const block of blocks) {
    const typeMatch = block.match(/(\d+)\.\s+(\S+(?:\s+\S+)?)\s+—\s+(\d{4}-\d{2}-\d{2})/);
    if (!typeMatch) continue;
    const record = { index: parseInt(typeMatch[1]), sport: typeMatch[2].trim(), date: typeMatch[3] };
    const durMatch = block.match(/Duration:\s+([\d:]+)/); if (durMatch) record.duration = durMatch[1];
    const distMatch = block.match(/Distance:\s+([\d.]+)\s+km/); if (distMatch) record.distance = parseFloat(distMatch[1]);
    const paceMatch = block.match(/Average Pace:\s+([\d:]+)\s+\/km/); if (paceMatch) record.avgPace = paceMatch[1];
    const hrMatch = block.match(/Avg HR:\s+(\d+)\s+bpm/); if (hrMatch) record.avgHR = parseInt(hrMatch[1]);
    const calMatch = block.match(/Calories:\s+(\d+)\s+kcal/); if (calMatch) record.calories = parseInt(calMatch[1]);
    const labelMatch = block.match(/LabelId:\s+(\d+)/); if (labelMatch) record.labelId = labelMatch[1];
    const sportTypeMatch = block.match(/SportType:\s+(\d+)/); if (sportTypeMatch) record.sportType = parseInt(sportTypeMatch[1]);
    const coordMatch = block.match(/Start Coordinates:\s+([\d.-]+),\s+([\d.-]+)/);
    if (coordMatch) record.startCoords = [parseFloat(coordMatch[1]), parseFloat(coordMatch[2])];
    records.push(record);
  }
  return records;
}

function parseActivityDetail(text) {
  if (!text) return null;
  const d = {};
  const strKeys = { workoutTime: /Workout Time:\s+([\d:]+)/, avgPace: /Average Pace:\s+([\d:]+)\s+\/km/,
    movingAvgPace: /Moving Average Pace:\s+([\d:]+)\s+\/km/, adjustedPace: /Adjusted Pace:\s+([\d:]+)\s+\/km/,
    bestKm: /Best Kilometer:\s+([\d:]+)\s+\/km/, performance: /Performance:\s+(.+)/ };
  const floatKeys = { distance: /Distance:\s+([\d.]+)\s+km/, avgStrideLength: /Average Stride Length:\s+([\d.]+)\s+m/ };
  const intKeys = { avgHR: /Average Heart Rate:\s+(\d+)\s+bpm/, avgCadence: /Average Cadence:\s+(\d+)\s+spm/,
    elevationGain: /Elevation Gain \/ Loss:\s+(\d+)\s+m/, calories: /Calories:\s+(\d+)\s+kcal/,
    trainingLoad: /Training Load:\s+(\d+)/ };
  const elMatch = text.match(/Elevation Gain \/ Loss:\s+\d+\s+m\s*\/\s*(\d+)\s+m/);
  if (elMatch) d.elevationLoss = parseInt(elMatch[1]);
  for (const [k, re] of Object.entries(strKeys)) { const m = text.match(re); if (m) d[k] = k === "performance" ? m[1].trim() : m[1]; }
  for (const [k, re] of Object.entries(floatKeys)) { const m = text.match(re); if (m) d[k] = parseFloat(m[1]); }
  for (const [k, re] of Object.entries(intKeys)) { const m = text.match(re); if (m) d[k] = parseInt(m[1]); }
  return Object.keys(d).length ? d : null;
}

function parseDailyHealth(text) {
  if (!text) return [];
  const days = [];
  const blocks = text.split(/---\s*(\d{8})\s*---/);
  for (let i = 1; i < blocks.length; i += 2) {
    const day = { date: blocks[i] };
    const b = blocks[i + 1];
    const m = (re) => b.match(re);
    const steps = m(/Steps:\s+([\d,]+)/); if (steps) day.steps = parseInt(steps[1].replace(/,/g, ""));
    const cal = m(/Calories:\s+(\d+)\s+kcal/); if (cal) day.calories = parseInt(cal[1]);
    const ex = m(/Exercise:\s+(\d+)\s+min/); if (ex) day.exerciseMin = parseInt(ex[1]);
    const stress = m(/Stress:\s+Avg\s+(\d+)/); if (stress) day.avgStress = parseInt(stress[1]);
    const score = m(/Score:\s+(\d+)/); if (score) day.sleepScore = parseInt(score[1]);
    const total = m(/Total:\s+([\dh ]+min)/); if (total) day.sleepTotal = total[1].trim();
    const deep = m(/Deep:\s+([\dh ]+min)/); if (deep) day.deepSleep = deep[1].trim();
    const light = m(/Light:\s+([\dh ]+min)/); if (light) day.lightSleep = light[1].trim();
    const rem = m(/REM:\s+([\dh ]+min)/); if (rem) day.remSleep = rem[1].trim();
    const awake = m(/Awake:\s+([\dh ]+min)/); if (awake) day.awakeTime = awake[1].trim();
    days.push(day);
  }
  return days;
}

function parseTrainingLoad(text) {
  if (!text) return [];
  const entries = [];
  const blocks = text.split(/\n(?=\d{4}-\d{2}-\d{2})/);
  for (const block of blocks) {
    const dm = block.match(/^(\d{4}-\d{2}-\d{2})/); if (!dm) continue;
    const e = { date: dm[1] };
    const cm = block.match(/Comment:\s+(.+)/); if (cm) e.comment = cm[1].trim();
    const st = block.match(/Short-Term Load:\s+(\d+)/); if (st) e.shortTermLoad = parseInt(st[1]);
    const lt = block.match(/Long-Term Load:\s+(\d+)/); if (lt) e.longTermLoad = parseInt(lt[1]);
    const lr = block.match(/Load Ratio:\s+([\d.]+)/); if (lr) e.loadRatio = parseFloat(lr[1]);
    entries.push(e);
  }
  return entries;
}

function parseHRV(text) {
  if (!text) return { baseline: null, normalRange: null, days: [] };
  const r = { baseline: null, normalRange: null, days: [] };
  const bl = text.match(/Baseline:\s+(\d+)\s+ms/); if (bl) r.baseline = parseInt(bl[1]);
  const nr = text.match(/Normal Range:\s+(\d+)\s*-\s*(\d+)\s+ms/);
  if (nr) r.normalRange = [parseInt(nr[1]), parseInt(nr[2])];
  const dayBlocks = text.split(/\n(?=\d{4}-\d{2}-\d{2}:)/);
  for (const block of dayBlocks) {
    const dm = block.match(/^(\d{4}-\d{2}-\d{2}):/); if (!dm) continue;
    const day = { date: dm[1] };
    const hv = block.match(/HRV Avg:\s+(\d+)\s+ms/); if (hv) day.hrv = parseInt(hv[1]);
    const ev = block.match(/—\s*(.+)/); if (ev) day.evaluation = ev[1].trim();
    r.days.push(day);
  }
  return r;
}

function parseRecoveryStatus(text) {
  if (!text) return null;
  const r = {};
  const p = text.match(/Recovery:\s+(\d+)%/); if (p) r.percentage = parseInt(p[1]);
  const l = text.match(/Level:\s+(.+)/); if (l) r.level = l[1].trim();
  const t = text.match(/Estimated Full Recovery:\s+(\d+h)/); if (t) r.estimatedFullRecovery = t[1];
  return Object.keys(r).length ? r : null;
}

function parseFitnessOverview(text) {
  if (!text) return null;
  const r = {};
  const v = text.match(/^VO2max:\s+(\d+)/m); if (v) r.vo2max = parseInt(v[1]);
  const l = text.match(/^Running Level:\s+(\d+)/m); if (l) r.runningLevel = parseInt(l[1]);
  const tp = text.match(/^Threshold Pace:\s+([\d:]+)\s+\/km/m); if (tp) r.thresholdPace = tp[1];
  const p5 = text.match(/^5 km Prediction:\s+([\d:]+)/m); if (p5) r.pred5k = p5[1];
  const p10 = text.match(/^10 km Prediction:\s+([\d:]+)/m); if (p10) r.pred10k = p10[1];
  const phm = text.match(/^Half Marathon Prediction:\s+([\d:]+)/m); if (phm) r.predHalfMarathon = phm[1];
  const pm = text.match(/^Marathon Prediction:\s+([\d:]+)/m); if (pm) r.predMarathon = pm[1];
  return Object.keys(r).length ? r : null;
}

function parseTrainingSchedule(text) {
  if (!text) return [];
  const entries = [];
  const blocks = text.split(/\n(?=\d{4}-\d{2}-\d{2})/);
  for (const block of blocks) {
    const dm = block.match(/^(\d{4}-\d{2}-\d{2})/); if (!dm) continue;
    const e = { date: dm[1] };
    const tm = block.match(/^\d{4}-\d{2}-\d{2}\n(.+)/m); if (tm) e.type = tm[1].trim();
    const dist = block.match(/Distance:\s+([\d.]+)\s+km/); if (dist) e.distance = parseFloat(dist[1]);
    const time = block.match(/Estimated Time:\s+([\d:]+)/); if (time) e.estimatedTime = time[1];
    const load = block.match(/Load:\s+(\d+)\s+TL/); if (load) e.load = parseInt(load[1]);
    entries.push(e);
  }
  return entries;
}

function parseSleepData(text) {
  if (!text) return [];
  const entries = [];
  const blocks = text.split(/\n(?=\d{4}-\d{2}-\d{2})/);
  for (const block of blocks) {
    const dm = block.match(/^(\d{4}-\d{2}-\d{2})/); if (!dm) continue;
    const e = { date: dm[1] };
    const sc = block.match(/Sleep Score:\s+(\d+)/); if (sc) e.sleepScore = parseInt(sc[1]);
    const ms = block.match(/Main Sleep:\s+([\dh ]+min)/); if (ms) e.mainSleep = ms[1].trim();
    const dp = block.match(/Deep Sleep Ratio:\s+(\d+)%/); if (dp) e.deepRatio = parseInt(dp[1]);
    const lp = block.match(/Light Sleep Ratio:\s+(\d+)%/); if (lp) e.lightRatio = parseInt(lp[1]);
    const rp = block.match(/REM Ratio:\s+(\d+)%/); if (rp) e.remRatio = parseInt(rp[1]);
    const ap = block.match(/Awake Ratio:\s+(\d+)%/); if (ap) e.awakeRatio = parseInt(ap[1]);
    const at = block.match(/Awake Time:\s+(\d+)\s+min/); if (at) e.awakeTimeMin = parseInt(at[1]);
    const sw = block.match(/Main Sleep Window:\s+([\d:]+)\s*-\s*([\d:]+)/);
    if (sw) e.sleepWindow = `${sw[1]} - ${sw[2]}`;
    entries.push(e);
  }
  return entries;
}

function parseUserInfo(text) {
  if (!text) return null;
  const r = {};
  const h = text.match(/Height:\s+([\d.]+)\s+cm/); if (h) r.height = parseFloat(h[1]);
  const w = text.match(/Weight:\s+([\d.]+)\s+kg/); if (w) r.weight = parseFloat(w[1]);
  const b = text.match(/Birthday:\s+(\d{4}-\d{2}-\d{2})/); if (b) r.birthday = b[1];
  const g = text.match(/Gender:\s+(\w+)/); if (g) r.gender = g[1];
  const n = text.match(/Nickname:\s+(\w+)/); if (n) r.nickname = n[1];
  return Object.keys(r).length ? r : null;
}

// --- Main ---

function fetchAll(dateStr, isFull) {
  const today = dateStr || formatDate(new Date());
  const startDate7 = formatDate(new Date(Date.now() - 7 * 86400000));
  const startDate3 = formatDate(new Date(Date.now() - 3 * 86400000));

  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset));
  const weekEnd = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + 6));

  const data = { fetchDate: today, fetchedAt: new Date().toISOString() };

  console.log("Fetching Coros data...");

  console.log("  [1/10] User info...");
  data.userInfo = parseUserInfo(callTool("queryUserInfo", {}));

  console.log("  [2/10] Sport records (7 days)...");
  const sportText = callTool("querySportRecords", {
    startDate: startDate7, endDate: today,
    sportTypeCodes: [65535], minDistanceKm: null, maxDistanceKm: null,
    minDurationMinutes: null, maxDurationMinutes: null, maxAveragePace: null,
    locationKeyword: null, limit: 20, timezone: TIMEZONE,
  });
  data.sportRecords = parseSportRecords(sportText);

  console.log("  [3/10] Activity details...");
  data.activityDetails = [];
  for (const record of data.sportRecords) {
    if (record.labelId && record.sportType) {
      const detailText = callTool("getActivityDetail", {
        labelId: record.labelId, sportType: record.sportType,
      });
      const detail = parseActivityDetail(detailText);
      if (detail) {
        detail.labelId = record.labelId;
        detail.sportType = record.sportType;
        detail.date = record.date;
        data.activityDetails.push(detail);
      }
    }
  }

  console.log("  [4/10] Daily health (7 days)...");
  data.dailyHealth = parseDailyHealth(callTool("queryDailyHealthData", { days: 7, timezone: TIMEZONE }));

  console.log("  [5/10] Sleep data (3 days)...");
  data.sleep = parseSleepData(callTool("querySleepData", {
    startDate: startDate3, endDate: today, days: 3, timezone: TIMEZONE,
  }));

  console.log("  [6/10] HRV (7 days)...");
  data.hrv = parseHRV(callTool("queryHrvAssessment", { days: 7, timezone: TIMEZONE }));

  console.log("  [7/10] Training load (7 days)...");
  data.trainingLoad = parseTrainingLoad(callTool("queryTrainingLoadAssessment", { days: 7 }));

  console.log("  [8/10] Recovery status...");
  data.recovery = parseRecoveryStatus(callTool("queryRecoveryStatus", {}));

  console.log("  [9/10] Fitness overview...");
  data.fitness = parseFitnessOverview(callTool("queryFitnessAssessmentOverview", {}));

  console.log("  [10/10] Training schedule (this week)...");
  data.trainingSchedule = parseTrainingSchedule(callTool("queryTrainingSchedule", {
    startDate: weekStart, endDate: weekEnd, timezone: TIMEZONE,
  }));

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `${today}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`\nSaved to ${outPath}`);
  console.log(`  Sport records: ${data.sportRecords.length}`);
  console.log(`  Activity details: ${data.activityDetails.length}`);
  console.log(`  Health days: ${data.dailyHealth.length}`);
  console.log(`  HRV days: ${data.hrv.days?.length ?? 0}`);
  console.log(`  Training load days: ${data.trainingLoad.length}`);
  console.log(`  Schedule entries: ${data.trainingSchedule.length}`);

  return data;
}

const args = parseArgs();
fetchAll(args.date, args.full);
