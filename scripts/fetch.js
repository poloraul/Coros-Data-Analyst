#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFIT } from "./fit-analyzer.js";
import { fetchWeather } from "../lib/weather.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");
const FIT_DIR = path.join(PROJECT_ROOT, "data", "fit");
const ISSUER = "https://mcpcn.coros.com";
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

function getAge(birthday) {
  const today = new Date();
  const birth = new Date(birthday);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

// Direct MCP protocol caller — bypasses the coros-mcp CLI's
// "mcp session id missing" bug (server returns no Mcp-Session-Id header
// after initialize, but tools/call works fine without a session id).
function readAccessToken() {
  const tokenPath = process.env.COROS_MCP_TOKEN_PATH
    || path.join(process.env.HOME, ".coros-mcp-skill-gateway-ts", "cn", "token.json");
  try {
    return JSON.parse(readFileSync(tokenPath, "utf8")).access_token;
  } catch (e) {
    return null;
  }
}

async function directMcpCall(toolName, args) {
  const token = readAccessToken();
  if (!token) {
    console.error(`  [WARN] no COROS access token found`);
    return null;
  }
  const mcpUrl = `${ISSUER}/mcp`;
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${token}`,
  };
  try {
    // initialize
    const initRes = await fetch(mcpUrl, {
      method: "POST", headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "coros-fetch", version: "1.0.0" } },
      }),
    });
    if (!initRes.ok) {
      console.error(`  [WARN] MCP init failed: ${initRes.status}`);
      return null;
    }
    await initRes.text();
    // notifications/initialized
    await fetch(mcpUrl, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    // tools/call
    const callRes = await fetch(mcpUrl, {
      method: "POST", headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    const callText = await callRes.text();
    const json = JSON.parse(callText);
    if (json.error) {
      console.error(`  [WARN] MCP tool error: ${JSON.stringify(json.error).slice(0, 120)}`);
      return null;
    }
    let text = json.result?.content?.[0]?.text || null;
    // Unwrap JSON-encoded string (server wraps plain text in quotes)
    if (text && text.startsWith('"') && text.endsWith('"')) {
      try { text = JSON.parse(text); } catch { /* keep as-is */ }
    }
    return text;
  } catch (e) {
    console.error(`  [WARN] MCP call exception: ${e.message}`);
    return null;
  }
}

function callTool(toolName, args, retries = 3) {
  // First try direct MCP protocol (works around coros-mcp CLI bug)
  return (async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const result = await directMcpCall(toolName, args);
      if (result !== null) return result;
      if (attempt < retries) {
        const delay = attempt * 1500;
        console.error(`  [WARN] ${toolName} failed, retrying in ${delay}ms (${attempt}/${retries})...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    console.error(`  [WARN] ${toolName} failed after ${retries} attempts`);
    return null;
  })();
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
    trainingLoad: /Training Load:\s+(\d+)/, avgPower: /Average Power:\s+(\d+)\s+W/ };
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
  // Only parse the "HRV Assessment" section — the "Sleep HRV Time Series"
  // section also has date headers (one per day) but with timestamp/hrv
  // entries, which would otherwise duplicate every date.
  const assessmentStart = text.indexOf("HRV Assessment");
  const section = assessmentStart >= 0 ? text.slice(assessmentStart) : text;
  const dayBlocks = section.split(/\n(?=\d{4}-\d{2}-\d{2}:)/);
  for (const block of dayBlocks) {
    const dm = block.match(/^(\d{4}-\d{2}-\d{2}):/); if (!dm) continue;
    const hv = block.match(/HRV Avg:\s+(\d+)\s+ms/); if (!hv) continue;
    const day = { date: dm[1], hrv: parseInt(hv[1]) };
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

/**
 * Fallback: find the most recent fitness data from nearby daily JSON files.
 * Used when queryFitnessAssessmentOverview returns null (transient API failure).
 */
function findRecentFitness(dateStr) {
  const todayNum = parseInt(dateStr);
  // Scan up to 7 days back
  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const pastDate = String(todayNum - daysBack);
    const pastPath = path.join(DATA_DIR, `${pastDate}.json`);
    try {
      const pastData = JSON.parse(readFileSync(pastPath, "utf-8"));
      if (pastData.fitness && pastData.fitness.vo2max) {
        pastData.fitness._sourceDate = pastDate;
        return pastData.fitness;
      }
    } catch { /* file not found or parse error, skip */ }
  }
  return null;
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

// --- Incremental fetch ---

async function fetchActivityDetails(sportRecords) {
  const details = [];
  for (const record of sportRecords) {
    if (record.labelId && record.sportType) {
      const detailText = await callTool("getActivityDetail", {
        labelId: record.labelId, sportType: record.sportType,
      });
      const detail = parseActivityDetail(detailText);
      if (detail) {
        detail.labelId = record.labelId;
        detail.sportType = record.sportType;
        detail.date = record.date;
        details.push(detail);
      }
    }
  }
  return details;
}

function mergeSportRecords(existing, incoming) {
  const map = new Map();
  for (const r of existing) map.set(r.labelId, r);
  for (const r of incoming) map.set(r.labelId, r);
  return [...map.values()];
}

function mergeActivityDetails(existing, incoming) {
  const map = new Map();
  for (const d of existing) map.set(d.labelId, d);
  for (const d of incoming) map.set(d.labelId, d);
  return [...map.values()];
}

function saveDailyData(today, data) {
  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `${today}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  return outPath;
}

function downloadFITFiles(dateStr) {
  try {
    const cmd = `node "${path.join(__dirname, "download-tcx.js")}" --date ${dateStr}`;
    execSync(cmd, { encoding: "utf-8", timeout: 120000, stdio: "pipe" });
    console.log("  FIT download complete.");
  } catch (e) {
    console.error(`  [WARN] FIT download failed: ${e.message.split("\n")[0]}`);
  }
}

function enrichWithFIT(data) {
  const details = data.activityDetails || [];
  if (details.length === 0) return;

  const birthday = data.userInfo?.birthday || "1990-01-01";
  const maxHR = 220 - getAge(birthday);
  let enriched = 0;

  for (const detail of details) {
    if (!detail.labelId || detail.tcxMetrics) continue;
    const fitPath = path.join(FIT_DIR, `${detail.labelId}.fit`);
    if (existsSync(fitPath)) {
      const metrics = analyzeFIT(fitPath, maxHR);
      if (metrics) {
        detail.tcxMetrics = metrics;
        enriched++;
      }
    }
  }
  console.log(`  FIT enriched: ${enriched}/${details.length} activities`);
}

/**
 * Reconcile activityDetails from FIT files.
 * For sportRecords that have a FIT file but no activityDetail entry,
 * parse the FIT to create one. This fixes cases where getActivityDetail
 * failed (e.g., old activities that synced late) while FIT was downloaded.
 */
function reconcileFromFIT(data) {
  const records = data.sportRecords || [];
  const details = data.activityDetails || [];
  const existingLabelIds = new Set(details.map(d => d.labelId));
  const birthday = data.userInfo?.birthday || "1990-01-01";
  const maxHR = 220 - getAge(birthday);
  let created = 0;

  for (const record of records) {
    if (!record.labelId || existingLabelIds.has(record.labelId)) continue;
    const fitPath = path.join(FIT_DIR, `${record.labelId}.fit`);
    if (!existsSync(fitPath)) continue;

    const metrics = analyzeFIT(fitPath, maxHR);
    if (!metrics) continue;

    // Parse duration (HH:MM:SS or MM:SS) into workoutTime
    const fmtDuration = (d) => {
      if (!d) return null;
      const parts = d.split(':');
      if (parts.length === 2) return d;
      if (parts.length === 3) return `${+parts[0]}:${parts[1]}:${parts[2]}`;
      return d;
    };

    const detail = {
      date: record.date,
      labelId: record.labelId,
      sportType: record.sportType,
      distance: record.distance,
      avgPace: record.avgPace,
      avgHR: record.avgHR,
      calories: record.calories,
      workoutTime: fmtDuration(record.duration),
      movingAvgPace: record.avgPace,
      adjustedPace: record.avgPace,
      bestKm: null,
      performance: null,
      avgCadence: metrics.cadence?.avgCadence || null,
      avgStrideLength: null,
      elevationGain: metrics.elevation?.gain || null,
      elevationLoss: metrics.elevation?.loss || null,
      trainingLoad: null,
      tcxMetrics: metrics,
    };

    data.activityDetails = data.activityDetails || [];
    data.activityDetails.push(detail);
    existingLabelIds.add(record.labelId);
    created++;
  }

  if (created > 0) console.log(`  FIT reconciled: ${created} activities (sportRecord → activityDetail via FIT)`);
}

async function enrichWithWeather(data) {
  const details = data.activityDetails || [];
  const records = data.sportRecords || [];
  if (details.length === 0 || records.length === 0) return;

  // Build labelId -> startCoords map
  const coordMap = {};
  for (const r of records) {
    if (r.labelId && r.startCoords) {
      coordMap[r.labelId] = r.startCoords;
    }
  }

  let enriched = 0;
  for (const detail of details) {
    if (detail.weather) continue;
    if (!detail.labelId) continue;
    const coords = coordMap[detail.labelId];
    if (!coords) continue;

    try {
      const weather = await fetchWeather(coords[0], coords[1], detail.date);
      if (weather) {
        detail.weather = weather;
        enriched++;
      }
    } catch (e) {
      // Silently skip — weather is non-critical
    }
  }
  console.log(`  Weather enriched: ${enriched}/${details.length} activities`);
}

// --- Main ---

function mergeWithExisting(today, fresh) {
  const existingPath = path.join(DATA_DIR, `${today}.json`);
  let existing;
  try { existing = JSON.parse(readFileSync(existingPath, "utf-8")); } catch { return fresh; }
  if (existing.fetchDate !== today) return fresh;

  let merged = 0;
  const merged_ = { ...fresh };

  // Object fields: keep existing if new fetch returned null/empty
  for (const key of ["userInfo", "recovery", "fitness"]) {
    if (!fresh[key] && existing[key]) {
      merged_[key] = existing[key];
      merged++;
    }
  }

  // Array fields: merge, preferring existing data
  for (const key of ["sportRecords", "activityDetails", "dailyHealth", "sleep", "trainingLoad", "trainingSchedule"]) {
    const f = fresh[key] || [];
    const e = existing[key] || [];
    if (f.length === 0 && e.length > 0) {
      merged_[key] = e;
      merged++;
    }
  }

  // HRV: special object with nested days array
  if (fresh.hrv && existing.hrv) {
    if ((!fresh.hrv.baseline && existing.hrv.baseline) || (fresh.hrv.days?.length === 0 && existing.hrv.days?.length > 0)) {
      merged_.hrv = existing.hrv;
      merged++;
    }
  }

  // Preserve any FIT/weather enrichment that was done previously
  for (const existingDetail of existing.activityDetails || []) {
    const match = merged_.activityDetails.find(d => d.labelId === existingDetail.labelId);
    if (match && existingDetail.tcxMetrics && !match.tcxMetrics) {
      match.tcxMetrics = existingDetail.tcxMetrics;
    }
    if (match && existingDetail.weather && !match.weather) {
      match.weather = existingDetail.weather;
    }
  }

  if (merged > 0) console.log(`  Merged ${merged} fields from existing data (kept on fetch failure)`);
  return merged_;
}

async function fetchAll(dateStr) {
  const today = dateStr || formatDate(new Date());
  const startDate7 = formatDate(new Date(Date.now() - 7 * 86400000));

  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset));
  const weekEnd = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + 6));

  const data = { fetchDate: today, fetchedAt: new Date().toISOString() };

  console.log("Fetching Coros data...");

  console.log("  [1/10] User info...");
  data.userInfo = parseUserInfo(await callTool("queryUserInfo", {}));

  console.log("  [2/10] Sport records (7 days)...");
  const sportText = await callTool("querySportRecords", {
    startDate: startDate7, endDate: today,
    sportTypeCodes: [65535], minDistanceKm: null, maxDistanceKm: null,
    minDurationMinutes: null, maxDurationMinutes: null, maxAveragePace: null,
    locationKeyword: null, limit: 20, timezone: TIMEZONE,
  });
  data.sportRecords = parseSportRecords(sportText);

  console.log("  [3/10] Activity details...");
  data.activityDetails = await fetchActivityDetails(data.sportRecords);

  console.log("  [4/10] Daily health (7 days)...");
  data.dailyHealth = parseDailyHealth(await callTool("queryDailyHealthData", { days: 7, timezone: TIMEZONE }));

  console.log("  [5/10] Sleep data (7 days)...");
  data.sleep = parseSleepData(await callTool("querySleepData", {
    startDate: startDate7, endDate: today, days: 7, timezone: TIMEZONE,
  }));

  console.log("  [6/10] HRV (7 days)...");
  data.hrv = parseHRV(await callTool("querySleepHrv", { days: 7, timezone: TIMEZONE }));

  console.log("  [7/10] Training load (7 days)...");
  data.trainingLoad = parseTrainingLoad(await callTool("queryTrainingLoadAssessment", { days: 7 }));

  console.log("  [8/10] Recovery status...");
  data.recovery = parseRecoveryStatus(await callTool("queryRecoveryStatus", {}));

  console.log("  [9/10] Fitness overview...");
  data.fitness = parseFitnessOverview(await callTool("queryFitnessAssessmentOverview", {}));
  if (!data.fitness) {
    const fallback = findRecentFitness(today);
    if (fallback) {
      data.fitness = fallback;
      console.log(`  Fitness data not available, using ${fallback._sourceDate} data`);
    }
  }

  console.log("  [10/10] Training schedule (this week)...");
  data.trainingSchedule = parseTrainingSchedule(await callTool("queryTrainingSchedule", {
    startDate: weekStart, endDate: weekEnd, timezone: TIMEZONE,
  }));

  // Merge with existing data — don't let a failed session overwrite good data
  const merged = mergeWithExisting(today, data);

  const outPath = saveDailyData(today, merged);
  console.log(`\nSaved to ${outPath}`);
  console.log(`  Sport records: ${merged.sportRecords.length}`);
  console.log(`  Activity details: ${merged.activityDetails.length}`);
  console.log(`  Health days: ${merged.dailyHealth.length}`);
  console.log(`  HRV days: ${merged.hrv.days?.length ?? 0}`);
  console.log(`  Training load days: ${merged.trainingLoad.length}`);
  console.log(`  Schedule entries: ${merged.trainingSchedule.length}`);

  // Download FIT files & enrich (using merged data)
  console.log("\nDownloading FIT files...");
  downloadFITFiles(today);
  enrichWithFIT(merged);
  reconcileFromFIT(merged);
  await enrichWithWeather(merged);
  saveDailyData(today, merged);

  return merged;
}

async function fetchIncremental(dateStr) {
  const today = dateStr || formatDate(new Date());
  const existingPath = path.join(DATA_DIR, `${today}.json`);

  let existing;
  try {
    existing = JSON.parse(readFileSync(existingPath, "utf-8"));
  } catch {
    return null;
  }

  if (existing.fetchDate !== today) return null;

  console.log(`Incremental update (data already fetched today at ${existing.fetchedAt})`);

  const startDate7 = formatDate(new Date(Date.now() - 7 * 86400000));

  console.log("  [1/7] Sport records (7 days)...");
  const sportText = await callTool("querySportRecords", {
    startDate: startDate7, endDate: today,
    sportTypeCodes: [65535], minDistanceKm: null, maxDistanceKm: null,
    minDurationMinutes: null, maxDurationMinutes: null, maxAveragePace: null,
    locationKeyword: null, limit: 20, timezone: TIMEZONE,
  });
  const newRecords = parseSportRecords(sportText);

  console.log("  [2/7] Activity details...");
  const newDetails = await fetchActivityDetails(newRecords);

  // Merge sport records
  const mergedRecords = mergeSportRecords(existing.sportRecords || [], newRecords);
  const mergedDetails = mergeActivityDetails(existing.activityDetails || [], newDetails);

  const newRecordCount = newRecords.filter(r => !(existing.sportRecords || []).some(e => e.labelId === r.labelId)).length;
  const newDetailCount = newDetails.filter(d => !(existing.activityDetails || []).some(e => e.labelId === d.labelId)).length;

  existing.sportRecords = mergedRecords;
  existing.activityDetails = mergedDetails;

  // Try to fill in missing non-sport fields (won't overwrite existing data)
  const fillFields = [
    { key: "userInfo", tool: "queryUserInfo", args: {}, parser: parseUserInfo, empty: null },
    { key: "fitness", tool: "queryFitnessAssessmentOverview", args: {}, parser: parseFitnessOverview, empty: null },
    { key: "recovery", tool: "queryRecoveryStatus", args: {}, parser: parseRecoveryStatus, empty: null },
    { key: "trainingLoad", tool: "queryTrainingLoadAssessment", args: { days: 7 }, parser: parseTrainingLoad, empty: [] },
    { key: "hrv", tool: "querySleepHrv", args: { days: 7, timezone: TIMEZONE }, parser: parseHRV, empty: { baseline: null, normalRange: null, days: [] } },
    { key: "dailyHealth", tool: "queryDailyHealthData", args: { days: 7, timezone: TIMEZONE }, parser: parseDailyHealth, empty: [] },
    { key: "sleep", tool: "querySleepData", args: { startDate: formatDate(new Date(Date.now() - 7 * 86400000)), endDate: today, days: 7, timezone: TIMEZONE }, parser: parseSleepData, empty: [] },
  ];
  let filled = 0;
  for (const { key, tool, args, parser, empty } of fillFields) {
    const cur = existing[key];
    const isEmpty = (v) => {
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === "object") return Object.keys(v).length === 0 || (v.days && Array.isArray(v.days) && v.days.length === 0 && !v.baseline);
      return false;
    };
    if (isEmpty(cur)) {
      console.log(`  [fill] ${key}...`);
      const text = await callTool(tool, args);
      const parsed = parser(text);
      if (!isEmpty(parsed)) {
        existing[key] = parsed;
        filled++;
      } else if (key === "fitness") {
        // Transient API failure fallback: use recent fitness data
        const fallback = findRecentFitness(today);
        if (fallback) {
          existing[key] = fallback;
          filled++;
          console.log(`    using ${fallback._sourceDate} fallback data`);
        }
      }
    }
  }
  if (filled > 0) console.log(`  Filled ${filled} missing fields`);

  existing.fetchedAt = new Date().toISOString();

  // Download new FIT files & enrich
  if (newDetailCount > 0) {
    console.log("\nDownloading new FIT files...");
    downloadFITFiles(today);
  }
  enrichWithFIT(existing);
  reconcileFromFIT(existing);
  await enrichWithWeather(existing);
  saveDailyData(today, existing);

  const outPath = path.join(DATA_DIR, `${today}.json`);
  console.log(`\nSaved to ${outPath}`);
  console.log(`  Sport records: ${mergedRecords.length} (+${newRecordCount} new)`);
  console.log(`  Activity details: ${mergedDetails.length} (+${newDetailCount} new)`);

  return existing;
}

const args = parseArgs();
(async () => {
  try {
    if (!args.full) {
      const result = await fetchIncremental(args.date);
      if (result) {
        console.log("STATUS:OK");
        process.exit(0);
      }
      console.log("No existing data for today, performing full fetch...");
    }
    await fetchAll(args.date);
    console.log("STATUS:OK");
    process.exit(0);
  } catch (e) {
    console.error(`STATUS:ERROR:${e.message}`);
    process.exit(1);
  }
})();
