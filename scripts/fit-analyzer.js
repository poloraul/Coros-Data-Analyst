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

    // Convert FIT semicircles to decimal degrees
    const lat = r.position_lat != null ? r.position_lat * (180 / Math.pow(2, 31)) : null;
    const lon = r.position_long != null ? r.position_long * (180 / Math.pow(2, 31)) : null;
    // Wrist temperature (Celsius), may not be available on all watches
    const temp = r.temperature != null ? r.temperature : null;

    trackpoints.push({
      time: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      dist,
      hr: r.heart_rate || 0,
      // COROS FIT cadence is already in SPM (full cycle)
      cadence: r.cadence || 0,
      speed: r.speed || 0,
      alt: r.altitude || 0,
      lat, // GPS latitude (decimal degrees)
      lon, // GPS longitude (decimal degrees)
      temp, // wrist temperature (Celsius)
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
  const mid170to180 = cads.filter((c) => c >= 170 && c < 180).length;
  const above180 = cads.filter((c) => c >= 180).length;
  const total = cads.length;
  const mean = cads.reduce((s, c) => s + c, 0) / cads.length;
  const variance = cads.reduce((s, c) => s + (c - mean) ** 2, 0) / cads.length;

  return {
    avgCadence: avg,
    stdDev: Math.round(Math.sqrt(variance)),
    pctBelow170: Math.round((below170 / total) * 100),
    pct170to180: Math.round((mid170to180 / total) * 100),
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

  const sum = alts.reduce((s, a) => s + a, 0);

  return {
    totalGain: Math.round(gain),
    totalLoss: Math.round(loss),
    net: Math.round(gain - loss),
    avgAlt: Math.round(sum / alts.length),
    minAlt: Math.round(Math.min(...alts)),
    maxAlt: Math.round(Math.max(...alts)),
  };
}

/**
 * Per-lap summaries from FIT lap messages.
 * Provides natural workout segments (vs arbitrary per-km splits).
 */
export function computeLapSummaries(laps, trackpoints) {
  if (!laps || laps.length === 0) return null;

  const summaries = laps.map((lap, i) => {
    const distM = lap.total_distance || lap.distance || 0;
    const timeSec = lap.total_elapsed_time || lap.total_timer_time || 0;
    const paceSecPerKm = distM > 0 && timeSec > 0 ? Math.round(timeSec / (distM / 1000)) : null;

    return {
      lapNum: i + 1,
      distanceKm: distM > 0 ? Math.round((distM / 1000) * 100) / 100 : 0,
      timeSec: Math.round(timeSec),
      paceSecPerKm,
      paceStr: paceSecPerKm ? secondsToPace(paceSecPerKm) : null,
      avgHR: lap.avg_heart_rate || null,
      maxHR: lap.max_heart_rate || null,
      avgCadence: lap.avg_cadence || null,
      avgPower: lap.avg_power || null,
      trigger: lap.lap_trigger || "unknown",
      intensity: lap.intensity || null,
    };
  });

  return summaries;
}

/**
 * Midpoint pace drift: split total distance at the midpoint and compare
 * first-half vs second-half average pace. Ported from tcx-utils.js.
 */
export function computePaceDrift(trackpoints) {
  const withDist = trackpoints.filter((tp) => tp.dist > 0 && tp.time);
  if (withDist.length < 4) return null;
  const totalM = withDist[withDist.length - 1].dist;
  if (totalM < 2000) return null;

  const midpoint = totalM / 2;
  let prev = null, next = null;
  for (let i = 1; i < withDist.length; i++) {
    if (withDist[i - 1].dist <= midpoint && withDist[i].dist >= midpoint) {
      prev = withDist[i - 1];
      next = withDist[i];
      break;
    }
  }
  if (!prev || !next) return null;

  const ratio = (midpoint - prev.dist) / (next.dist - prev.dist);
  const midTimeSec = (new Date(prev.time).getTime() / 1000) +
    ratio * ((new Date(next.time).getTime() / 1000) - (new Date(prev.time).getTime() / 1000));
  const startTime = new Date(withDist[0].time).getTime() / 1000;
  const endTime = new Date(withDist[withDist.length - 1].time).getTime() / 1000;

  const firstHalfKm = midpoint / 1000;
  const secondHalfKm = (totalM - midpoint) / 1000;
  const firstHalfSec = midTimeSec - startTime;
  const secondHalfSec = endTime - midTimeSec;
  const firstPace = firstHalfSec / firstHalfKm;
  const secondPace = secondHalfSec / secondHalfKm;
  const driftPct = firstPace > 0 ? ((secondPace - firstPace) / firstPace) * 100 : 0;

  return {
    firstHalfPace: secondsToPace(firstPace),
    firstHalfPaceSeconds: Math.round(firstPace),
    secondHalfPace: secondsToPace(secondPace),
    secondHalfPaceSeconds: Math.round(secondPace),
    driftPct: Math.round(driftPct * 10) / 10,
  };
}

/**
 * Main entry: parse FIT and return structured metrics.
 * Enhanced with lap summaries, pace drift, GPS, maxHR, avgTemp.
 */
export function analyzeFIT(fitPath, maxHR) {
  if (!existsSync(fitPath)) return null;

  try {
    const { trackpoints, sessions, laps } = parseFIT(fitPath);
    if (trackpoints.length === 0) return null;

    const totalDist = Math.round(trackpoints.reduce((max, tp) => Math.max(max, tp.dist), 0));
    const splits = computeKMSplits(trackpoints);
    const hrDrift = computeHRDrift(trackpoints);
    const hrZones = computeHRZoneMinutes(trackpoints, maxHR);
    const paceCV = computePaceCV(splits);
    const cadence = computeCadenceAnalysis(trackpoints);
    const elevation = computeElevation(trackpoints);
    const paceDrift = computePaceDrift(trackpoints);
    const lapSummaries = computeLapSummaries(laps, trackpoints);

    // Extract maxHR from first FIT session (most reliable)
    const sessionMaxHR = sessions?.[0]?.max_heart_rate || null;

    // Extract GPS trackpoints (filter out null lat/lon)
    const gpsTrackpoints = trackpoints
      .filter((tp) => tp.lat != null && tp.lon != null && tp.dist > 0)
      .map((tp) => ({
        lat: tp.lat,
        lon: tp.lon,
        dist: tp.dist,
        alt: tp.alt || null,
      }));

    // Average wrist temperature (if available)
    const temps = trackpoints.map((tp) => tp.temp).filter((t) => t != null);
    const avgTemp = temps.length > 0
      ? Math.round((temps.reduce((s, t) => s + t, 0) / temps.length) * 10) / 10
      : null;

    return {
      totalDistanceMeters: totalDist,
      totalKm: Math.round((totalDist / 1000) * 100) / 100,
      trackpointsCount: trackpoints.length,
      kmSplits: splits,
      hrDrift,
      hrZones,
      paceCV,
      paceDrift,
      cadence,
      elevation,
      lapSummaries,
      maxHR: sessionMaxHR,
      avgTemp,
      gpsTrackpoints: gpsTrackpoints.length > 0 ? gpsTrackpoints : null,
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
