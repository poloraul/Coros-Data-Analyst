import { readFileSync } from "node:fs";

const LAP_RE = /<(?:\w+:)?Lap[^>]*>[\s\S]*?<\/(?:\w+:)?Lap>/g;
const TIME_RE = /<(?:\w+:)?TotalTimeSeconds>([\d.]+)<\//;
const DIST_RE = /<(?:\w+:)?DistanceMeters>([\d.]+)<\//;
const CAL_RE = /<(?:\w+:)?Calories>(\d+)<\//;
const AVG_HR_RE = /<(?:\w+:)?AverageHeartRateBpm>\s*<(?:\w+:)?Value>(\d+)<\//;
const MAX_HR_RE = /<(?:\w+:)?MaximumHeartRateBpm>\s*<(?:\w+:)?Value>(\d+)<\//;
const LAP_INTENSITY_RE = /<(?:\w+:)?Intensity>([^<]+)<\//;
const LAP_TRIGGER_RE = /<(?:\w+:)?TriggerMethod>([^<]+)<\//;

const TP_HR_RE = /<(?:\w+:)?HeartRateBpm>\s*<(?:\w+:)?Value>(\d+)<\//;
const TP_DIST_RE = /<(?:\w+:)?DistanceMeters>([\d.]+)<\//;
const TP_TIME_RE = /<(?:\w+:)?Time>([^<]+)<\//;
const TP_CADENCE_RE = /<(?:\w+:)?Cadence>(\d+)<\//;
const TP_ALT_RE = /<(?:\w+:)?AltitudeMeters>([\d.-]+)<\//;
const TP_SPEED_RE = /<(?:\w+:)?Speed>([\d.]+)<\//;
const TP_LAT_RE = /<(?:\w+:)?LatitudeDegrees>([\d.-]+)<\//;
const TP_LON_RE = /<(?:\w+:)?LongitudeDegrees>([\d.-]+)<\//;

export function parseTcxLaps(tcxContent) {
  const laps = [];
  const lapMatches = tcxContent.match(LAP_RE) || [];
  for (const lapXml of lapMatches) {
    const int = (re) => { const m = lapXml.match(re); return m ? parseInt(m[1]) : null; };
    const float = (re) => { const m = lapXml.match(re); return m ? parseFloat(m[1]) : null; };
    const str = (re) => { const m = lapXml.match(re); return m ? m[1] : null; };
    const lap = {
      totalTimeSeconds: float(TIME_RE),
      distanceMeters: float(DIST_RE),
      avgHR: int(AVG_HR_RE),
      maxHR: int(MAX_HR_RE),
      calories: int(CAL_RE),
      intensity: str(LAP_INTENSITY_RE),
      triggerMethod: str(LAP_TRIGGER_RE),
    };

    const trackpoints = [];
    const tpXmls = lapXml.match(/<(?:\w+:)?Trackpoint>[\s\S]*?<\/(?:\w+:)?Trackpoint>/g) || [];
    for (const tpXml of tpXmls) {
      const tp = {};
      const h = tpXml.match(TP_HR_RE);
      if (h) tp.hr = parseInt(h[1]);
      const d = tpXml.match(TP_DIST_RE);
      if (d) tp.distanceMeters = parseFloat(d[1]);
      const t = tpXml.match(TP_TIME_RE);
      if (t) tp.time = t[1];
      const c = tpXml.match(TP_CADENCE_RE);
      if (c) tp.cadence = parseInt(c[1]) * 2;
      const a = tpXml.match(TP_ALT_RE);
      if (a) tp.altitudeMeters = parseFloat(a[1]);
      const s = tpXml.match(TP_SPEED_RE);
      if (s) tp.speed = parseFloat(s[1]);
      const lat = tpXml.match(TP_LAT_RE);
      if (lat) tp.lat = parseFloat(lat[1]);
      const lon = tpXml.match(TP_LON_RE);
      if (lon) tp.lon = parseFloat(lon[1]);
      trackpoints.push(tp);
    }
    lap.trackpoints = trackpoints;
    laps.push(lap);
  }
  return laps;
}

export function calculateHrZones(trackpoints, maxHR) {
  if (!trackpoints?.length || !maxHR) return null;
  const zones = { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 };
  const boundaries = [maxHR * 0.6, maxHR * 0.7, maxHR * 0.8, maxHR * 0.9, Infinity];
  let total = 0;
  for (const tp of trackpoints) {
    if (!tp.hr) continue;
    total++;
    for (let i = 0; i < boundaries.length; i++) {
      if (tp.hr < boundaries[i]) {
        zones[`zone${i + 1}`]++;
        break;
      }
    }
  }
  if (total === 0) return null;
  for (const key of Object.keys(zones)) zones[key] = Math.round((zones[key] / total) * 100);
  return zones;
}

function secToPace(secondsPerKm) {
  if (!secondsPerKm || !isFinite(secondsPerKm)) return null;
  const min = Math.floor(secondsPerKm / 60);
  const sec = Math.round(secondsPerKm % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function paceToSeconds(pace) {
  if (!pace) return null;
  const parts = pace.split(":");
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  return null;
}

function formatDuration(totalSeconds) {
  if (!totalSeconds) return "-";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function getTcxSummary(tcxFilePath) {
  const content = readFileSync(tcxFilePath, "utf-8");
  const laps = parseTcxLaps(content);
  if (!laps.length) return null;

  const totalTimeSec = laps.reduce((s, l) => s + (l.totalTimeSeconds || 0), 0);
  const totalDistM = laps.reduce((s, l) => s + (l.distanceMeters || 0), 0);
  const totalCal = laps.reduce((s, l) => s + (l.calories || 0), 0);
  const allHRs = laps.flatMap(l => l.trackpoints?.map(tp => tp.hr).filter(Boolean) || []);
  const avgHR = allHRs.length ? Math.round(allHRs.reduce((a, b) => a + b, 0) / allHRs.length) : null;

  const maxObservedHR = allHRs.length ? Math.max(...allHRs) : null;

  return {
    totalDistanceKm: totalDistM > 0 ? Math.round(totalDistM / 10) / 100 : 0,
    totalTimeMin: totalTimeSec > 0 ? Math.round(totalTimeSec / 6) / 10 : 0,
    avgPace: totalTimeSec > 0 && totalDistM > 0 ? secToPace(totalTimeSec / (totalDistM / 1000)) : null,
    avgHR,
    calories: totalCal || null,
    hrZones: calculateHrZones(laps.flatMap(l => l.trackpoints || []), maxObservedHR),
    lapCount: laps.length,
    trackpointCount: laps.reduce((s, l) => s + (l.trackpoints?.length || 0), 0),
  };
}

export function computeLapSplits(trackpoints) {
  const withDist = trackpoints.filter(tp => tp.distanceMeters != null && tp.time);
  if (withDist.length < 3) return null;

  const totalM = withDist[withDist.length - 1].distanceMeters;
  if (totalM < 1000) return null;

  const kmCount = Math.floor(totalM / 1000);
  const splits = [];

  for (let km = 1; km <= kmCount; km++) {
    const boundary = km * 1000;
    let prev = null;
    let next = null;
    for (let i = 1; i < withDist.length; i++) {
      if (withDist[i - 1].distanceMeters <= boundary && withDist[i].distanceMeters >= boundary) {
        prev = withDist[i - 1];
        next = withDist[i];
        break;
      }
    }
    if (!prev || !next) {
      splits.push({ km, paceSeconds: null, paceStr: null, hr: null, cumulativeTimeSeconds: null });
      continue;
    }
    const ratio = (boundary - prev.distanceMeters) / (next.distanceMeters - prev.distanceMeters);
    const boundaryTimeSec = parseTimeToSec(prev.time) + ratio * (parseTimeToSec(next.time) - parseTimeToSec(prev.time));
    const prevTime = km === 1 ? parseTimeToSec(withDist[0].time) : (splits[km - 2]?.cumulativeTimeSeconds || parseTimeToSec(withDist[0].time));

    const prevCumSec = km === 1 ? 0 : (splits[km - 2]?.cumulativeTimeSeconds || 0);
    const lapTimeSec = boundaryTimeSec - (km === 1 ? parseTimeToSec(withDist[0].time) : prevCumSec + parseTimeToSec(withDist[0].time));
    const actualPrevCum = km === 1 ? parseTimeToSec(withDist[0].time) : (splits[km - 2]?.nextTimeSec || parseTimeToSec(withDist[0].time));
    const lapSec = boundaryTimeSec - actualPrevCum;

    const nearestHr = next.hr || prev.hr || null;
    splits.push({
      km,
      paceSeconds: Math.round(lapSec),
      paceStr: secToPace(lapSec),
      hr: nearestHr,
      cumulativeTimeSeconds: Math.round(boundaryTimeSec - parseTimeToSec(withDist[0].time)),
      nextTimeSec: boundaryTimeSec,
    });
  }

  return splits.length ? splits : null;
}

function parseTimeToSec(timeStr) {
  if (!timeStr) return 0;
  const d = new Date(timeStr);
  return d.getTime() / 1000;
}

export function analyzePaceDrift(trackpoints) {
  const withDist = trackpoints.filter(tp => tp.distanceMeters != null && tp.time);
  if (withDist.length < 4) return null;
  const totalM = withDist[withDist.length - 1].distanceMeters;
  if (totalM < 2000) return null;

  const midpoint = totalM / 2;
  let prev = null;
  let next = null;
  for (let i = 1; i < withDist.length; i++) {
    if (withDist[i - 1].distanceMeters <= midpoint && withDist[i].distanceMeters >= midpoint) {
      prev = withDist[i - 1];
      next = withDist[i];
      break;
    }
  }
  if (!prev || !next) return null;

  const ratio = (midpoint - prev.distanceMeters) / (next.distanceMeters - prev.distanceMeters);
  const midTimeSec = parseTimeToSec(prev.time) + ratio * (parseTimeToSec(next.time) - parseTimeToSec(prev.time));
  const startTime = parseTimeToSec(withDist[0].time);
  const endTime = parseTimeToSec(withDist[withDist.length - 1].time);

  const firstHalfKm = midpoint / 1000;
  const secondHalfKm = (totalM - midpoint) / 1000;
  const firstHalfSec = midTimeSec - startTime;
  const secondHalfSec = endTime - midTimeSec;
  const firstPace = firstHalfSec / firstHalfKm;
  const secondPace = secondHalfSec / secondHalfKm;
  const driftPct = firstPace > 0 ? ((secondPace - firstPace) / firstPace) * 100 : 0;

  return {
    firstHalfPace: secToPace(firstPace),
    firstHalfPaceSeconds: Math.round(firstPace),
    secondHalfPace: secToPace(secondPace),
    secondHalfPaceSeconds: Math.round(secondPace),
    driftPct: Math.round(driftPct * 10) / 10,
  };
}

export function analyzeCadence(trackpoints) {
  const values = trackpoints.map(tp => tp.cadence).filter(Boolean);
  if (values.length < 10) return null;

  const sum = values.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / values.length);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const stdDev = Math.round(Math.sqrt(values.reduce((sq, v) => sq + (v - avg) ** 2, 0) / values.length) * 10) / 10;

  let low = 0, mid = 0, high = 0;
  for (const v of values) {
    if (v < 170) low++;
    else if (v >= 180) high++;
    else mid++;
  }
  const total = values.length;

  return {
    avg, min, max, stdDev,
    distribution: {
      pctBelow170: Math.round((low / total) * 100),
      pct170to180: Math.round((mid / total) * 100),
      pctAbove180: Math.round((high / total) * 100),
    },
  };
}

export function computePerKmHrTrend(splits) {
  if (!splits?.length) return null;
  const trend = splits.map(s => ({ km: s.km, avgHR: s.hr })).filter(t => t.avgHR != null);
  return trend.length >= 2 ? trend : null;
}

export function analyzeElevation(trackpoints) {
  const values = trackpoints.map(tp => tp.altitudeMeters).filter(a => a != null);
  if (values.length < 2) return null;

  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0.5) gain += diff;
    else if (diff < -0.5) loss += Math.abs(diff);
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10;

  return {
    gain: Math.round(gain),
    loss: Math.round(loss),
    net: Math.round(gain - loss),
    max, min, avg,
  };
}

export function getTcxEnrichedAnalysis(tcxContent) {
  const laps = parseTcxLaps(tcxContent);
  if (!laps.length) return null;

  const allTrackpoints = laps.flatMap(l => l.trackpoints || []);
  const totalTimeSec = laps.reduce((s, l) => s + (l.totalTimeSeconds || 0), 0);
  const totalDistM = laps.reduce((s, l) => s + (l.distanceMeters || 0), 0);
  const allHRs = allTrackpoints.map(tp => tp.hr).filter(Boolean);
  const avgHR = allHRs.length ? Math.round(allHRs.reduce((a, b) => a + b, 0) / allHRs.length) : null;
  const maxObservedHR = allHRs.length ? Math.max(...allHRs) : null;

  const lapSummaries = laps.map((l, i) => ({
    lapNum: i + 1,
    distanceKm: l.distanceMeters ? Math.round(l.distanceMeters / 10) / 100 : null,
    timeMinutes: l.totalTimeSeconds ? Math.round(l.totalTimeSeconds / 6) / 10 : null,
    paceStr: l.totalTimeSeconds && l.distanceMeters ? secToPace(l.totalTimeSeconds / (l.distanceMeters / 1000)) : null,
    avgHR: l.avgHR,
    maxHR: l.maxHR,
  }));

  return {
    laps,
    allTrackpoints,
    splits: computeLapSplits(allTrackpoints),
    paceDrift: analyzePaceDrift(allTrackpoints),
    cadenceStats: analyzeCadence(allTrackpoints),
    elevationStats: analyzeElevation(allTrackpoints),
    hrZones: calculateHrZones(allTrackpoints, maxObservedHR || 220),
    lapSummaries,
    summary: {
      totalDistanceKm: totalDistM > 0 ? Math.round(totalDistM / 10) / 100 : 0,
      totalTimeMin: totalTimeSec > 0 ? Math.round(totalTimeSec / 6) / 10 : 0,
      avgPace: totalTimeSec > 0 && totalDistM > 0 ? secToPace(totalTimeSec / (totalDistM / 1000)) : null,
      avgHR,
      lapCount: laps.length,
      trackpointCount: allTrackpoints.length,
    },
  };
}
