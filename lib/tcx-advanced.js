import { computeLapSplits, analyzePaceDrift } from "./tcx-utils.js";

function parseTimeToSec(timeStr) {
  if (!timeStr) return 0;
  const d = new Date(timeStr);
  return d.getTime() / 1000;
}

export function computeAerobicDecoupling(trackpoints) {
  const withDist = trackpoints.filter(tp => tp.distanceMeters != null && tp.time && tp.hr);
  if (withDist.length < 10) return null;

  const totalM = withDist[withDist.length - 1].distanceMeters;
  if (totalM < 3000) return null;

  const midpoint = totalM / 2;
  let splitIdx = 0;
  for (let i = 1; i < withDist.length; i++) {
    if (withDist[i].distanceMeters >= midpoint) { splitIdx = i; break; }
  }
  if (splitIdx === 0) return null;

  const firstHalf = withDist.slice(0, splitIdx + 1);
  const secondHalf = withDist.slice(splitIdx);

  function paceToHrRatio(segment) {
    const startT = parseTimeToSec(segment[0].time);
    const endT = parseTimeToSec(segment[segment.length - 1].time);
    const startD = segment[0].distanceMeters;
    const endD = segment[segment.length - 1].distanceMeters;
    const hrs = segment.map(tp => tp.hr).filter(Boolean);
    const avgHR = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : 0;
    const durSec = endT - startT;
    const distKm = (endD - startD) / 1000;
    const pace = distKm > 0 ? durSec / distKm : 0;
    return avgHR > 0 ? pace / avgHR : 0;
  }

  const firstRatio = paceToHrRatio(firstHalf);
  const secondRatio = paceToHrRatio(secondHalf);

  if (firstRatio === 0) return null;
  const decouplingPct = ((secondRatio - firstRatio) / firstRatio) * 100;

  let assessment;
  if (Math.abs(decouplingPct) < 3) assessment = "优秀 — 有氧耐力扎实，前后半程 pace:HR 一致性高";
  else if (Math.abs(decouplingPct) < 5) assessment = "良好 — 轻微脱钩，属正常范围";
  else if (decouplingPct > 5) assessment = "注意 — 后半程心率漂移明显，有氧耐力待加强";
  else assessment = "注意 — 后半程配速下降但心率也降低，可能主动降速";

  return { value: Math.round(decouplingPct * 10) / 10, assessment };
}

export function computePaceVariability(splits) {
  if (!splits?.length || splits.length < 2) return null;
  const paces = splits.map(s => s.paceSeconds).filter(p => p != null && p > 0);
  if (paces.length < 2) return null;

  const avg = paces.reduce((a, b) => a + b, 0) / paces.length;
  const variance = paces.reduce((sq, p) => sq + (p - avg) ** 2, 0) / paces.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / avg) * 100;

  let assessment;
  if (cv < 2) assessment = "极佳 — 配速非常均匀";
  else if (cv < 4) assessment = "良好 — 配速控制稳定";
  else if (cv < 6) assessment = "一般 — 配速有一定波动";
  else assessment = "需改善 — 配速波动较大，建议关注匀速控制";

  return { cv: Math.round(cv * 10) / 10, stdDev: Math.round(stdDev), assessment };
}

export function computeRunningEfficiencyIndex(trackpoints) {
  const withData = trackpoints.filter(tp => tp.speed != null && tp.hr != null && tp.hr > 0);
  if (withData.length < 20) return null;

  const segmentSize = Math.max(20, Math.floor(withData.length / 4));
  const segments = [];
  for (let i = 0; i < withData.length; i += segmentSize) {
    const chunk = withData.slice(i, i + segmentSize);
    const avgSpeed = chunk.reduce((s, tp) => s + tp.speed, 0) / chunk.length;
    const avgHR = chunk.reduce((s, tp) => s + tp.hr, 0) / chunk.length;
    if (avgHR > 0) segments.push({ index: segments.length, rei: avgSpeed / avgHR, avgSpeed, avgHR });
  }

  if (segments.length < 2) return null;

  const firstRei = segments[0].rei;
  const lastRei = segments[segments.length - 1].rei;
  const trendPct = firstRei > 0 ? ((lastRei - firstRei) / firstRei) * 100 : 0;

  let trend;
  if (trendPct > 2) trend = "提升 — 跑步效率随训练进程提高";
  else if (trendPct > -2) trend = "稳定 — 跑步效率基本维持";
  else trend = "下降 — 后段跑步效率降低，可能疲劳累积";

  return { startIndex: segments[0].rei, endIndex: lastRei, trendPct: Math.round(trendPct * 10) / 10, trend, segments };
}

export function computeHrRecoveryRate(trackpoints) {
  const withHr = trackpoints.filter(tp => tp.hr != null && tp.time);
  if (withHr.length < 10) return null;

  let peakHR = 0;
  let peakIdx = 0;
  for (let i = 0; i < withHr.length; i++) {
    if (withHr[i].hr > peakHR) { peakHR = withHr[i].hr; peakIdx = i; }
  }

  if (peakIdx >= withHr.length - 5) return null;

  const peakTime = parseTimeToSec(withHr[peakIdx].time);
  let hrAt60s = null;
  for (let i = peakIdx + 1; i < withHr.length; i++) {
    const t = parseTimeToSec(withHr[i].time);
    if (t - peakTime >= 60) { hrAt60s = withHr[i].hr; break; }
  }

  if (hrAt60s == null) return null;
  const drop = peakHR - hrAt60s;

  let assessment;
  if (drop >= 30) assessment = "优秀 — 心血管恢复能力强";
  else if (drop >= 20) assessment = "良好 — 恢复能力正常";
  else if (drop >= 10) assessment = "一般 — 恢复能力偏弱，需关注";
  else assessment = "注意 — 心率恢复缓慢，可能训练过度或恢复不足";

  return { peakHR, hrAt60s, drop, assessment };
}
