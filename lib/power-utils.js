/**
 * 跑步功率工具库
 *
 * 数据源约束：当前仅能从 COROS get_activity_detail 获取单值 Average Power
 * （无逐秒功率，因此不能计算 NP/VI/EF/W'bal 等高阶指标）。
 *
 * 参考标准（基于 Running Power 行业经验，参考 TrainingPeaks / Stryd 6 区模型）：
 *   Z1 积极恢复: < 55% FTP
 *   Z2 有氧耐力: 55-75% FTP
 *   Z3 有氧动力: 75-90% FTP
 *   Z4 乳酸阈:   90-105% FTP
 *   Z5 速度耐力: 105-120% FTP
 *   Z6 无氧动力: > 120% FTP
 */

const POWER_ZONE_DEFS = [
  { key: "Z1", name: "积极恢复区", low: 0.00, high: 0.55, color: "#7ec882" },
  { key: "Z2", name: "有氧耐力区", low: 0.55, high: 0.75, color: "#4db8a4" },
  { key: "Z3", name: "有氧动力区", low: 0.75, high: 0.90, color: "#f4c542" },
  { key: "Z4", name: "乳酸阈区",   low: 0.90, high: 1.05, color: "#e89898" },
  { key: "Z5", name: "速度耐力区", low: 1.05, high: 1.20, color: "#c07070" },
  { key: "Z6", name: "无氧动力区", low: 1.20, high: Infinity, color: "#d94f4f" },
];

/**
 * 计算 W/kg（功率体重比），用于跨体重横向比较
 * @param {number} watts - 功率（瓦）
 * @param {number} weightKg - 体重（kg）
 * @returns {number|null} W/kg，保留 2 位小数
 */
function calcWkg(watts, weightKg) {
  if (!watts || !weightKg || weightKg <= 0) return null;
  return Math.round((watts / weightKg) * 100) / 100;
}

/**
 * 估算跑步 FTP（基于最近户外跑历史）
 *
 * 行业经验：跑步 FTP ≈ 0.90 × avgPower of a sustained hard effort（参考 Stryd 文档）
 * 由于本项目仅能取到每次活动的 avgPower（非 60min 等效），用最近 3 次有效跑步
 * 的平均功率 × 0.90 估算。
 *
 * @param {Array<{date:string, distance?:number, avgPower:number}>} runningHistory
 *        跑步活动列表，按日期降序；只取 sportType=100（户外跑）有效
 * @param {number} weightKg
 * @returns {{ftpW:number|null, ftpWkg:number|null, sampleSize:number, confidence:"high"|"medium"|"low"|"none"}}
 */
function estimateFTP(runningHistory, weightKg) {
  const valid = (runningHistory || [])
    .filter(r => r.avgPower > 0 && (r.distance || 0) >= 5) // 仅 5km+ 跑步样本
    .slice(0, 3);
  if (valid.length === 0) {
    return { ftpW: null, ftpWkg: null, sampleSize: 0, confidence: "none" };
  }
  // 加权：距离越长的样本权重越高
  const totalDist = valid.reduce((s, r) => s + (r.distance || 0), 0);
  if (totalDist <= 0) {
    return { ftpW: null, ftpWkg: null, sampleSize: valid.length, confidence: "low" };
  }
  const weightedAvg = valid.reduce((s, r) => s + r.avgPower * (r.distance || 0), 0) / totalDist;
  const ftpW = Math.round(weightedAvg * 0.90);
  const ftpWkg = calcWkg(ftpW, weightKg);
  const confidence = valid.length >= 3 ? "high" : valid.length === 2 ? "medium" : "low";
  return { ftpW, ftpWkg, sampleSize: valid.length, confidence };
}

/**
 * 功率区间分类（基于 FTP 百分比）
 * @param {number} watts - 当前功率（瓦）
 * @param {number} ftpW - FTP 阈值功率（瓦）
 * @returns {number} 区间索引 0-5 (Z1-Z6)，若无法计算则返回 2 (Z3)
 */
function classifyPowerZone(watts, ftpW) {
  if (!watts || !ftpW || ftpW <= 0) return 2;
  const pct = watts / ftpW;
  if (pct < 0.55) return 0;
  if (pct < 0.75) return 1;
  if (pct < 0.90) return 2;
  if (pct < 1.05) return 3;
  if (pct < 1.20) return 4;
  return 5;
}

/**
 * 计算功率区间表（用于展示）
 * @param {number} ftpW
 * @returns {Array<{key, name, range, pct, color}>|null}
 */
function calcPowerZones(ftpW) {
  if (!ftpW || ftpW <= 0) return null;
  return POWER_ZONE_DEFS.map((z) => {
    let range;
    if (z.high === Infinity) {
      range = `> ${Math.round(ftpW * z.low)} W`;
    } else if (z.low === 0) {
      range = `< ${Math.round(ftpW * z.high)} W`;
    } else {
      range = `${Math.round(ftpW * z.low)} — ${Math.round(ftpW * z.high)} W`;
    }
    const pct = z.high === Infinity
      ? `>${Math.round(z.low * 100)}%`
      : z.low === 0
        ? `<${Math.round(z.high * 100)}%`
        : `${Math.round(z.low * 100)}-${Math.round(z.high * 100)}%`;
    return { key: z.key, name: z.name, range, pct, color: z.color };
  });
}

/**
 * 功率心率比 = W / bpm（越大越经济）
 * @param {number} watts
 * @param {number} hr
 * @returns {number|null} 保留 2 位小数
 */
function calcPowerToHRRatio(watts, hr) {
  if (!watts || !hr || hr <= 0) return null;
  return Math.round((watts / hr) * 100) / 100;
}

export {
  POWER_ZONE_DEFS,
  calcWkg,
  estimateFTP,
  classifyPowerZone,
  calcPowerZones,
  calcPowerToHRRatio,
};
