/**
 * 恢复状态评估（共用模块）
 * 根据 HRV 和恢复度百分比判定恢复等级：green/yellow/red
 */

/**
 * @param {object} data - daily JSON 数据（含 hrv、recovery 字段）
 * @returns {{ level: string, reasons: string[], recoveryPct: number|null, latestHRV: number|null, consecutiveBelow: number, baseline: number|null, normalRange: number[]|null }}
 */
export function assessRecovery(data) {
  const hrvDays = data.hrv?.days || [];
  const normalLow = data.hrv?.normalRange?.[0] || 50;
  const recovery = data.recovery;
  let consecutiveBelow = 0;
  for (const day of hrvDays) {
    if (day.hrv < normalLow) consecutiveBelow++;
    else break;
  }
  let level = "green";
  const reasons = [];
  if (consecutiveBelow >= 3) {
    level = "red";
    reasons.push(`HRV连续${consecutiveBelow}天低于正常范围`);
  } else if (consecutiveBelow >= 2) {
    level = "yellow";
    reasons.push(`HRV连续${consecutiveBelow}天低于正常范围`);
  }
  if (recovery?.percentage && recovery.percentage < 70) {
    level = "red";
    reasons.push(`恢复度仅${recovery.percentage}%`);
  } else if (recovery?.percentage && recovery.percentage < 85 && level === "green") {
    level = "yellow";
    reasons.push(`恢复度${recovery.percentage}%偏低`);
  }
  return {
    level,
    reasons,
    recoveryPct: recovery?.percentage || null,
    latestHRV: hrvDays[0]?.hrv || null,
    consecutiveBelow,
    baseline: data.hrv?.baseline || null,
    normalRange: data.hrv?.normalRange || null,
  };
}
