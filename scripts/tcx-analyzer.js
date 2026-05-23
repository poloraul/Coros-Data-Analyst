#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";

/**
 * Parse TCX XML and extract all trackpoints with cumulative distance.
 * Each lap's trackpoints have lap-relative distances; this function
 * converts them to cumulative distance across the entire activity.
 */
export function parseTCX(tcxPath) {
  const xml = readFileSync(tcxPath, "utf-8");

  // Extract all Laps to get boundary distances
  const lapDistances = [];
  const lapRegex = /<Lap[^>]*>([\s\S]*?)<\/Lap>/g;
  let lapMatch;
  while ((lapMatch = lapRegex.exec(xml)) !== null) {
    const dist = parseFloat(
      lapMatch[1].match(/<DistanceMeters>([^<]+)<\/DistanceMeters>/)?.[1] || 0
    );
    lapDistances.push(dist);
  }

  // Extract all trackpoints globally, assigning cumulative distance per lap
  let cumulativeDist = 0;
  let lapIndex = 0;
  const trackpoints = [];
  const globalTpRegex = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
  let tpMatch;

  // We need to track which lap each trackpoint belongs to.
  // Strategy: split the XML by lap boundaries, then parse trackpoints within each lap.
  const lapContents = [];
  const lapContentRegex = /<Lap[^>]*>([\s\S]*?)<\/Lap>/g;
  let lapContentMatch;
  while ((lapContentMatch = lapContentRegex.exec(xml)) !== null) {
    lapContents.push(lapContentMatch[1]);
  }

  for (let li = 0; li < lapContents.length; li++) {
    const content = lapContents[li];
    const tpRegex = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
    while ((tpMatch = tpRegex.exec(content)) !== null) {
      const tp = tpMatch[1];
      const distInLap = parseFloat(
        tp.match(/<DistanceMeters>([^<]+)<\/DistanceMeters>/)?.[1] || 0
      );
      const hr = parseInt(
        tp.match(/<HeartRateBpm>\s*<Value>(\d+)<\/Value>\s*<\/HeartRateBpm>/)?.[1] || 0
      );
      const cadence = parseInt(
        tp.match(/<Cadence>(\d+)<\/Cadence>/)?.[1] || 0
      );
      const speed = parseFloat(
        tp.match(/<Speed>([^<]+)<\/Speed>/)?.[1] || 0
      );
      const alt = parseFloat(
        tp.match(/<AltitudeMeters>([^<]+)<\/AltitudeMeters>/)?.[1] || 0
      );
      const time = tp.match(/<Time>([^<]+)<\/Time>/)?.[1] || null;

      // Coros TCX cadence is half-cycle (single-leg), multiply by 2 for SPM
      const spm = cadence > 0 ? cadence * 2 : 0;

      // Only store if at least one meaningful data point
      if (hr > 0 || distInLap > 0 || spm > 0 || speed > 0) {
        trackpoints.push({
          time,
          dist: cumulativeDist + distInLap,
          hr,
          cadence: spm,
          speed,
          alt,
        });
      }
    }
    cumulativeDist += lapDistances[li] || 0;
  }

  return trackpoints;
}

/**
 * Compute per-km split data from trackpoints.
 * Returns array of {km, paceSecPerKm, paceStr, avgHR, cadence}.
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
    if (inKm.length < 2) {
      kmStart = target;
      continue;
    }

    const first = inKm[0];
    const last = inKm[inKm.length - 1];
    const segTime = (new Date(last.time) - new Date(first.time)) / 1000;
    const segDist = last.dist - first.dist;

    if (segDist < 100) {
      // Too little data — skip
      kmStart = target;
      continue;
    }

    const avgHR = Math.round(
      inKm.reduce((s, tp) => s + tp.hr, 0) / inKm.length
    );
    const validCads = inKm.filter((tp) => tp.cadence > 0);
    const avgCad =
      validCads.length > 0
        ? Math.round(
            validCads.reduce((s, tp) => s + tp.cadence, 0) / validCads.length
          )
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
 * Lower drift indicates better aerobic fitness.
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
    evaluation:
      drift < 3 ? "excellent" : drift < 5 ? "good" : drift < 8 ? "fair" : "poor",
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
    else if (pct >= 0.5) zones.z1++;
  }

  const toMin = (s) => Math.round((s / 60) * 10) / 10;
  const total = hrs.length / 60;
  const z1m = toMin(zones.z1);
  const z2m = toMin(zones.z2);
  const z3m = toMin(zones.z3);
  const z4m = toMin(zones.z4);
  const z5m = toMin(zones.z5);

  const dominant =
    [
      [z1m, "Z1"],
      [z2m, "Z2"],
      [z3m, "Z3"],
      [z4m, "Z4"],
      [z5m, "Z5"],
    ].sort((a, b) => b[0] - a[0])[0][1];

  return {
    zone1Min: z1m,
    zone2Min: z2m,
    zone3Min: z3m,
    zone4Min: z4m,
    zone5Min: z5m,
    totalMin: Math.round(total * 10) / 10,
    pctZ1Z2: total > 0 ? Math.round(((z1m + z2m) / total) * 100) : 0,
    pctZ3Z4: total > 0 ? Math.round(((z3m + z4m) / total) * 100) : 0,
    pctZ5: total > 0 ? Math.round((z5m / total) * 100) : 0,
    dominantZone: dominant,
  };
}

/**
 * Pace consistency — coefficient of variation of per-km paces.
 * Lower CV = more even pacing.
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
 * Cadence analysis — average, variability, time below/above thresholds.
 */
export function computeCadenceAnalysis(trackpoints) {
  const cads = trackpoints
    .map((tp) => tp.cadence)
    .filter((c) => c > 0);
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
  if (alts.length < 5)
    return { totalGain: 0, totalLoss: 0, minAlt: 0, maxAlt: 0 };

  let gain = 0;
  let loss = 0;
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
 * Main entry: run all TCX analyses and return structured metrics.
 */
export function analyzeTCX(tcxPath, maxHR) {
  if (!existsSync(tcxPath)) return null;

  try {
    const trackpoints = parseTCX(tcxPath);
    if (trackpoints.length === 0) return null;

    const totalDist = trackpoints.reduce(
      (max, tp) => Math.max(max, tp.dist),
      0
    );

    const splits = computeKMSplits(trackpoints);
    const hrDrift = computeHRDrift(trackpoints);
    const hrZones = computeHRZoneMinutes(trackpoints, maxHR);
    const paceCV = computePaceCV(splits);
    const cadence = computeCadenceAnalysis(trackpoints);
    const elevation = computeElevation(trackpoints);

    return {
      totalDistanceMeters: Math.round(totalDist),
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
    console.error(`  [ERROR] TCX parse: ${e.message}`);
    return null;
  }
}

function secondsToPace(secs) {
  if (!secs || secs <= 0) return "-";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// CLI support
if (process.argv[1]?.endsWith("tcx-analyzer.js")) {
  const tcxPath = process.argv[2];
  if (!tcxPath) {
    console.error("Usage: node tcx-analyzer.js <tcx-file> [maxHR]");
    process.exit(1);
  }
  const maxHR = parseInt(process.argv[3]) || 182;
  const result = analyzeTCX(tcxPath, maxHR);
  console.log(JSON.stringify(result, null, 2));
}
