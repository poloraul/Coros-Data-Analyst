/**
 * 跑步配速区间 & 心率区间计算
 *
 * 基于阈值配速 (T-pace) 和最大心率 (HRmax) 计算标准 5 区体系
 * 参考 Jack Daniels / COROS 分区标准
 */

/**
 * 将 "mm:ss/km" 格式的配速转换为秒
 */
function paceToSec(pace) {
  if (!pace) return null;
  const m = pace.match(/^(\d+):(\d+)/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
}

/**
 * 将秒转换为 "mm:ss/km" 格式
 */
function secToPace(sec) {
  if (sec == null || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 分区定义模板
 */
const ZONE_LABELS = [
  { key: "Z1", name: "恢复跑", color: "#7ec882", short: "恢复" },
  { key: "Z2", name: "轻松跑", color: "#4db8a4", short: "轻松" },
  { key: "Z3", name: "马拉松配速", color: "#f4c542", short: "M配速" },
  { key: "Z4", name: "阈值跑", color: "#e89898", short: "阈值" },
  { key: "Z5", name: "间歇跑", color: "#c07070", short: "间歇" },
];

/**
 * 计算配速区间（基于阈值配速的百分比）
 *
 * 分区标准（% of threshold pace，%越高 = 越快）:
 *   Z1 恢复跑:  < 81%  → pace > tp/0.81 (比阈值慢)
 *   Z2 轻松跑:  81-91% → tp/0.91 ~ tp/0.81
 *   Z3 马拉松:  91-98% → tp/0.98 ~ tp/0.91
 *   Z4 阈值跑:  98-106% → tp/1.06 ~ tp/0.98
 *   Z5 间歇跑:  > 106% → pace < tp/1.06 (比阈值快)
 */
function calcPaceZones(thresholdPace) {
  const tpSec = paceToSec(thresholdPace);
  if (!tpSec) return null;

  // 边界值：slower 端（大数字）→ faster 端（小数字）
  const boundaries = [
    { slower: Infinity, faster: Math.round(tpSec / 0.81) },      // Z1: > 5:19
    { slower: Math.round(tpSec / 0.81), faster: Math.round(tpSec / 0.91) }, // Z2: 5:19 ~ 4:44
    { slower: Math.round(tpSec / 0.91), faster: Math.round(tpSec / 0.98) }, // Z3: 4:44 ~ 4:23
    { slower: Math.round(tpSec / 0.98), faster: Math.round(tpSec / 1.06) }, // Z4: 4:23 ~ 4:03
    { slower: Math.round(tpSec / 1.06), faster: 0 },              // Z5: < 4:03
  ];

  const zones = boundaries.map((b, i) => {
    const pctLow = [0, 0.81, 0.91, 0.98, 1.06][i];
    const pctHigh = [0.81, 0.91, 0.98, 1.06, 1.30][i];
    let range;
    if (i === 0) {
      range = `> ${secToPace(b.faster)}/km`;        // Z1: 比阈值慢
    } else if (i === 4) {
      range = `< ${secToPace(b.slower)}/km`;         // Z5: 比阈值快
    } else {
      range = `${secToPace(b.slower)}/km — ${secToPace(b.faster)}/km`; // Z2-Z4
    }
    return {
      ...ZONE_LABELS[i],
      pctOfThreshold: `${Math.round(pctLow * 100)}-${Math.round(pctHigh * 100)}%`,
      range,
    };
  });

  return {
    thresholdPace,
    thresholdPaceSec: tpSec,
    zones,
  };
}

/**
 * 计算心率区间
 *
 * 支持两种模式：
 * 1. LTHR 模式（推荐）：基于乳酸阈心率，5 区标准
 *    Z1 <81%, Z2 81-87%, Z3 88-93%, Z4 94-100%, Z5 >100%
 * 2. HRmax 模式（降级）：基于最大心率，5 区标准
 *    Z1 50-60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 90-100%
 *
 * @param {number} primaryHR - 主要心率值（LTHR 或 HRmax）
 * @param {object} [opts] - 选项
 * @param {number} [opts.restingHR] - 静息心率（可选，仅 HRmax 模式下用于 Karvonen 计算）
 * @param {boolean} [opts.useLTHR=true] - true=LTHR模式, false=HRmax模式
 */
function calcHRZones(primaryHR, opts = {}) {
  if (!primaryHR || primaryHR <= 0) return null;
  const { restingHR, useLTHR = true } = opts;

  let zones, modeLabel, modeKey;

  if (useLTHR) {
    // === LTHR 模式 ===
    // COROS 标准: Z1 <81%, Z2 81-87%, Z3 88-93%, Z4 94-100%, Z5 >100%
    const pcts = [
      { low: 0, high: 0.81 },
      { low: 0.81, high: 0.87 },
      { low: 0.87, high: 0.94 },
      { low: 0.94, high: 1.00 },
      { low: 1.00, high: 1.10 },
    ];
    zones = pcts.map((p, i) => {
      const hrLow = i === 0 ? 0 : Math.round(primaryHR * p.low);
      const hrHigh = i === 4 ? null : Math.round(primaryHR * p.high);
      const hrRange = i === 0 ? `< ${Math.round(primaryHR * 0.81)} bpm`
        : i === 4 ? `> ${Math.round(primaryHR * 1.00)} bpm`
        : `${Math.round(primaryHR * p.low)} — ${Math.round(primaryHR * p.high)} bpm`;
      return {
        ...ZONE_LABELS[i],
        hrRange,
        hrRangeShort: i === 4 ? `>${Math.round(primaryHR * 1.00)}`
          : i === 0 ? `<${Math.round(primaryHR * 0.81)}`
          : `${Math.round(primaryHR * p.low)}-${Math.round(primaryHR * p.high)}`,
        pctLTHR: i === 0 ? `<81%`
          : i === 4 ? `>100%`
          : `${Math.round(p.low * 100)}-${Math.round(p.high * 100)}%`,
      };
    });
    modeLabel = `乳酸阈心率 ${primaryHR} bpm`;
    modeKey = "lthr";
  } else {
    // === HRmax 模式（原逻辑） ===
    const pcts = [
      { low: 0.50, high: 0.60 },
      { low: 0.60, high: 0.70 },
      { low: 0.70, high: 0.80 },
      { low: 0.80, high: 0.90 },
      { low: 0.90, high: 1.00 },
    ];
    zones = pcts.map((p, i) => {
      const hrLow = Math.round(primaryHR * p.low);
      const hrHigh = Math.round(primaryHR * p.high);
      const hrRange = `${hrLow} — ${hrHigh} bpm`;

      let hrRangeKarvonen = null;
      if (restingHR && restingHR > 0) {
        const hrr = primaryHR - restingHR;
        hrRangeKarvonen = `${Math.round(restingHR + hrr * p.low)} — ${Math.round(restingHR + hrr * p.high)} bpm`;
      }

      return {
        ...ZONE_LABELS[i],
        hrRange,
        hrRangeShort: i === 4 ? `>${hrLow}` : `${hrLow}-${hrHigh}`,
        hrRangeKarvonen,
        pctMaxHR: `${Math.round(p.low * 100)}-${Math.round(p.high * 100)}%`,
      };
    });
    modeLabel = `最大心率 ${primaryHR} bpm`;
    modeKey = "hrmax";
  }

  return {
    refHR: primaryHR,
    mode: modeKey,
    modeLabel,
    restingHR: restingHR || null,
    zones,
  };
}

/**
 * 根据配速（秒/km）判断所属区间索引 (0=Z1, ..., 4=Z5)
 */
function classifyPace(paceSec, thresholdPaceSec) {
  if (!paceSec || !thresholdPaceSec || thresholdPaceSec <= 0) return 2; // default Z3
  const ratio = thresholdPaceSec / paceSec; // >1 = faster than threshold
  if (ratio > 1.06) return 4; // Z5 Interval
  if (ratio > 0.98) return 3; // Z4 Threshold
  if (ratio > 0.91) return 2; // Z3 Marathon
  if (ratio > 0.81) return 1; // Z2 Easy
  return 0; // Z1 Recovery
}

/**
 * 根据心率判断所属区间索引
 * @param {number} hr - 当前心率
 * @param {number} refHR - 参考心率（LTHR 或 HRmax）
 * @param {string} [mode="lthr"] - "lthr" 或 "hrmax"
 */
function classifyHR(hr, refHR, mode = "lthr") {
  if (!hr || !refHR || refHR <= 0) return 2;
  if (mode === "lthr") {
    const pct = hr / refHR;
    if (pct >= 1.00) return 4;   // Z5 > LTHR
    if (pct >= 0.94) return 3;   // Z4 94-100%
    if (pct >= 0.87) return 2;   // Z3 87-94%
    if (pct >= 0.81) return 1;   // Z2 81-87%
    return 0;                     // Z1 < 81%
  } else {
    const pct = hr / refHR;
    if (pct >= 0.90) return 4;
    if (pct >= 0.80) return 3;
    if (pct >= 0.70) return 2;
    if (pct >= 0.60) return 1;
    return 0;
  }
}

export {
  paceToSec,
  secToPace,
  calcPaceZones,
  calcHRZones,
  classifyPace,
  classifyHR,
  ZONE_LABELS,
};
