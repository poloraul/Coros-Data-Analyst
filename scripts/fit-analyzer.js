#!/usr/bin/env node
/**
 * fit-analyzer.js — 解析 COROS FIT 文件，对齐 tcx-analyzer.js 的输出指标
 *
 * 输出格式与 analyzeTCX() 完全一致，作为替换件使用。
 */
import { readFileSync, existsSync } from "node:fs";
import FitParser from "fit-file-parser";

// ============================================================
// FIT 解析
// ============================================================
export function parseFIT(fitPath) {
  const buffer = readFileSync(fitPath);
  const parser = new FitParser({ force: true, speedUnit: "m/s", lengthUnit: "m", elapsedRecordField: true });
  const data = parser.parse(buffer);

  const sessions = data?.activity?.sessions || [];
  const records = data?.activity?.records || [];
  const laps = data?.activity?.laps || [];

  // Extract trackpoints from FIT records
  const trackpoints = [];
  for (const r of records) {
    const dist = r.distance != null ? r.distance : 0;
    // Skip records with no meaningful data
    if (dist <= 0 && (!r.heart_rate || r.heart_rate <= 0) && (!r.cadence || r.cadence <= 0)) continue;

    trackpoints.push({
      time: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      dist,
      hr: r.heart_rate || 0,
      // COROS FIT cadence is already in SPM (full cycle)
      cadence: r.cadence || 0,
      speed: r.speed || 0,
      alt: r.altitude || 0,
    });
  }

  return { trackpoints, sessions, laps };
}

// ============================================================
// 以下函数与 tcx-analyzer.js 完全对齐
// ============================================================

function secondsToPace(secs) {
  if (!secs || secs <= 0) return "-";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Compute per-km split data from trackpoints.
 */
export function computeKMSplits(trackpoints) {
  const valid = trackpoints.filter((tp) => tp.dist > 0 && tp.hr > 0);
  if (valid.length < 3) return [];

  const totalDist = valid[valid.length - 1].dist;
  const maxKm = Math.floor(totalDist / 1000);
  if (maxKm < 1) return [];

  const splits = [];
  let kmStart = 0;

  for (let km = 1; km <= maxKm; km++) {
    const target = km * 1000;
    const inKm = valid.filter((tp) => tp.dist >= kmStart && tp.dist < target);
    if (inKm.length < 2) { kmStart = target; continue; }

    const first = inKm[0];
    const last = inKm[inKm.length - 1];
    const segTime = (new Date(last.time) - new Date(first.time)) / 1000;
    const segDist = last.dist - first.dist;

    if (segDist < 100) { kmStart = target; continue; }

    const avgHR = Math.round(inKm.reduce((s, tp) => s + tp.hr, 0) / inKm.length);
    const validCads = inKm.filter((tp) => tp.cadence > 0);
    const avgCad = validCads.length > 0
      ? Math.round(validCads.reduce((s, tp) => s + tp.cadence, 0) / validCads.length)
      : 0;

    splits.push({
      km,
      paceSecPerKm: Math.round(segTime / (segDist / 1000)),
      paceStr: secondsToPace(segTime / (segDist / 1000)),
      avgHR,
      avgCadence: avgCad,
    });

    kmStart = target;
  }

  return splits;
}

/**
 * HR drift: compare average HR in the first third vs last third of distance.
 */
export function computeHRDrift(trackpoints) {
  const valid = trackpoints.filter((tp) => tp.dist > 0 && tp.hr > 0);
  if (valid.length < 20) return null;

  const totalDist = valid[valid.length - 1].dist;
  const first = valid.filter((tp) => tp.dist <= totalDist / 3);
  const last = valid.filter((tp) => tp.dist >= (totalDist * 2) / 3);

  if (first.length < 5 || last.length < 5) return null;

  const avgFirst = first.reduce((s, tp) => s + tp.hr, 0) / first.length;
  const avgLast = last.reduce((s, tp) => s + tp.hr, 0) / last.length;
  const drift = ((avgLast - avgFirst) / avgFirst) * 100;

  return {
    driftPct: Math.round(drift * 10) / 10,
    avgHRFirst: Math.round(avgFirst),
    avgHRLast: Math.round(avgLast),
    evaluation: drift < 3 ? "excellent" : drift < 5 ? "good" : drift < 8 ? "fair" : "poor",
  };
}

/**
 * Time distribution across 5 HR zones (based on maxHR).
 */
export function computeHRZoneMinutes(trackpoints, maxHR) {
  if (!maxHR) return null;
  const hrs = trackpoints.map((tp) => tp.hr).filter((h) => h > 0);
  if (hrs.length < 10) return null;

  const zones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (const hr of hrs) {
    const pct = hr / maxHR;
    if (pct >= 0.9) zones.z5++;
    else if (pct >= 0.8) zones.z4++;
    else if (pct >= 0.7) zones.z3++;
    else if (pct >= 0.6) zones.z2++;
    else zones.z1++;
  }

  const toMin = (s) => Math.round((s / 60) * 10) / 10;
  const total = hrs.length / 60;
  const z1m = toMin(zones.z1);
  const z2m = toMin(zones.z2);
  const z3m = toMin(zones.z3);
  const z4m = toMin(zones.z4);
  const z5m = toMin(zones.z5);

  const dominant = [[z1m, "Z1"],[z2m, "Z2"],[z3m, "Z3"],[z4m, "Z4"],[z5m, "Z5"]]
    .sort((a, b) => b[0] - a[0])[0][1];

  return {
    zone1Min: z1m, zone2Min: z2m, zone3Min: z3m, zone4Min: z4m, zone5Min: z5m,
    totalMin: Math.round(total * 10) / 10,
    pctZ1Z2: total > 0 ? Math.round(((z1m + z2m) / total) * 100) : 0,
    pctZ3Z4: total > 0 ? Math.round(((z3m + z4m) / total) * 100) : 0,
    pctZ5: total > 0 ? Math.round((z5m / total) * 100) : 0,
    dominantZone: dominant,
  };
}

/**
 * Pace consistency — coefficient of variation of per-km paces.
 */
export function computePaceCV(splits) {
  if (splits.length < 3) return null;
  const paces = splits.map((s) => s.paceSecPerKm);
  const mean = paces.reduce((s, p) => s + p, 0) / paces.length;
  const variance = paces.reduce((s, p) => s + (p - mean) ** 2, 0) / paces.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / mean) * 100;
  return {
    cvPct: Math.round(cv * 10) / 10,
    stdDevSec: Math.round(stdDev),
    evaluation: cv < 3 ? "excellent" : cv < 6 ? "good" : cv < 10 ? "fair" : "poor",
  };
}

/**
 * Cadence analysis.
 */
export function computeCadenceAnalysis(trackpoints) {
  const cads = trackpoints.map((tp) => tp.cadence).filter((c) => c > 0);
  if (cads.length < 5) return null;

  const avg = Math.round(cads.reduce((s, c) => s + c, 0) / cads.length);
  const below170 = cads.filter((c) => c < 170).length;
  const above180 = cads.filter((c) => c >= 180).length;
  const total = cads.length;
  const mean = cads.reduce((s, c) => s + c, 0) / cads.length;
  const variance = cads.reduce((s, c) => s + (c - mean) ** 2, 0) / cads.length;

  return {
    avgCadence: avg,
    stdDev: Math.round(Math.sqrt(variance)),
    pctBelow170: Math.round((below170 / total) * 100),
    pctAbove180: Math.round((above180 / total) * 100),
  };
}

/**
 * Elevation gain/loss and min/max altitude.
 */
export function computeElevation(trackpoints) {
  const alts = trackpoints.map((tp) => tp.alt).filter((a) => a > 0);
  if (alts.length < 5) return { totalGain: 0, totalLoss: 0, minAlt: 0, maxAlt: 0 };

  let gain = 0, loss = 0;
  for (let i = 1; i < alts.length; i++) {
    const diff = alts[i] - alts[i - 1];
    if (diff > 0) gain += diff;
    else loss += Math.abs(diff);
  }

  return {
    totalGain: Math.round(gain),
    totalLoss: Math.round(loss),
    minAlt: Math.round(Math.min(...alts)),
    maxAlt: Math.round(Math.max(...alts)),
  };
}

/**
 * Main entry: parse FIT and return structured metrics (same as analyzeTCX).
 */
export function analyzeFIT(fitPath, maxHR) {
  if (!existsSync(fitPath)) return null;

  try {
    const { trackpoints } = parseFIT(fitPath);
    if (trackpoints.length === 0) return null;

    const totalDist = Math.round(trackpoints.reduce((max, tp) => Math.max(max, tp.dist), 0));
    const splits = computeKMSplits(trackpoints);
    const hrDrift = computeHRDrift(trackpoints);
    const hrZones = computeHRZoneMinutes(trackpoints, maxHR);
    const paceCV = computePaceCV(splits);
    const cadence = computeCadenceAnalysis(trackpoints);
    const elevation = computeElevation(trackpoints);

    return {
      totalDistanceMeters: totalDist,
      totalKm: Math.round((totalDist / 1000) * 100) / 100,
      trackpointsCount: trackpoints.length,
      kmSplits: splits,
      hrDrift,
      hrZones,
      paceCV,
      cadence,
      elevation,
    };
  } catch (e) {
    console.error(`  [ERROR] FIT parse: ${e.message}`);
    return null;
  }
}

// CLI support
if (process.argv[1]?.endsWith("fit-analyzer.js")) {
  const fitPath = process.argv[2];
  if (!fitPath) {
    console.error("Usage: node fit-analyzer.js <fit-file> [maxHR]");
    process.exit(1);
  }
  const maxHR = parseInt(process.argv[3]) || 182;
  const result = analyzeFIT(fitPath, maxHR);
  console.log(JSON.stringify(result, null, 2));
}
