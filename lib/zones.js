/**
 * 跑步配速区间 & 心率区间计算
 *
 * 基于阈值配速 (T-pace) 和最大心率 (HRmax) 计算
 * 配速区间采用 COROS 6 区标准（基于乳酸阈配速百分比）
 * 心率区间仍保留原 5 区 LTHR/HRmax 标准
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
  { key: "Z1", name: "积极恢复区", color: "#7ec882", short: "恢复" },
  { key: "Z2", name: "有氧耐力区", color: "#4db8a4", short: "有氧耐" },
  { key: "Z3", name: "有氧动力区", color: "#f4c542", short: "有氧动" },
  { key: "Z4", name: "乳酸阈区", color: "#e89898", short: "阈值" },
  { key: "Z5", name: "速度耐力区", color: "#c07070", short: "速度耐" },
  { key: "Z6", name: "无氧动力区", color: "#d94f4f", short: "无氧" },
];

/**
 * 计算配速区间（基于乳酸阈配速百分比，COROS 6 区标准）
 *
 * 分区标准（% of threshold pace，%越高 = 越快）:
 *   Z1 积极恢复区:  < 71%  → pace > tp/0.71
 *   Z2 有氧耐力区:  71-85% → tp/0.85 ~ tp/0.71
 *   Z3 有氧动力区:  86-93% → tp/0.93 ~ tp/0.86 (边界以 tp/0.85 为 Z2 上限)
 *   Z4 乳酸阈区:    94-102% → tp/1.02 ~ tp/0.94 (边界以 tp/0.93 为 Z3 上限)
 *   Z5 速度耐力区:  103-112% → tp/1.12 ~ tp/1.03 (边界以 tp/1.02 为 Z4 上限)
 *   Z6 无氧动力区:  > 112% → pace < tp/1.12
 */
function calcPaceZones(thresholdPace) {
  const tpSec = paceToSec(thresholdPace);
  if (!tpSec) return null;

  // 边界百分比（区间的转换点）:
  //   Z1/Z2 边界: 71%, Z2/Z3 边界: 85%, Z3/Z4 边界: 93%,
  //   Z4/Z5 边界: 102%, Z5/Z6 边界: 112%
  const pcts = [0.71, 0.85, 0.93, 1.02, 1.12];
  const boundaries = [
    { slower: Infinity, faster: Math.round(tpSec / pcts[0]) },        // Z1: > tp/0.71
    { slower: Math.round(tpSec / pcts[0]), faster: Math.round(tpSec / pcts[1]) }, // Z2
    { slower: Math.round(tpSec / pcts[1]), faster: Math.round(tpSec / pcts[2]) }, // Z3
    { slower: Math.round(tpSec / pcts[2]), faster: Math.round(tpSec / pcts[3]) }, // Z4
    { slower: Math.round(tpSec / pcts[3]), faster: Math.round(tpSec / pcts[4]) }, // Z5
    { slower: Math.round(tpSec / pcts[4]), faster: 0 },               // Z6: < tp/1.12
  ];

  // Display % labels matching COROS spec
  const displayPcts = [
    { low: 0, high: 71 },
    { low: 71, high: 85 },
    { low: 86, high: 93 },
    { low: 94, high: 102 },
    { low: 103, high: 112 },
    { low: 112, high: 130 },
  ];

  const zones = boundaries.map((b, i) => {
    let range;
    if (i === 0) {
      range = `> ${secToPace(b.faster)}/km`;
    } else if (i === 5) {
      range = `< ${secToPace(b.slower)}/km`;
    } else {
      range = `${secToPace(b.slower)}/km — ${secToPace(b.faster)}/km`;
    }
    const pctStr = i === 0 ? `<${displayPcts[i].high}%`
      : i === 5 ? `>${displayPcts[i].low}%`
      : `${displayPcts[i].low}-${displayPcts[i].high}%`;
    return {
      ...ZONE_LABELS[i],
      pctOfThreshold: pctStr,
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
    // === LTHR 模式 (COROS 6 区标准) ===
    // Z1 <80%, Z2 80-90%, Z3 91-95%, Z4 96-102%, Z5 103-106%, Z6 >106%
    // 用于计算的区间边界: Z1/Z2:80%, Z2/Z3:90%, Z3/Z4:96%, Z4/Z5:102%, Z5/Z6:106%
    const bounds = [0.80, 0.90, 0.96, 1.02, 1.06];
    // 显示用的百分比标签（按用户指定）
    const pctLabels = [
      { low: null, high: "80" },
      { low: "80", high: "90" },
      { low: "91", high: "95" },
      { low: "96", high: "102" },
      { low: "103", high: "106" },
      { low: "106", high: null },
    ];
    zones = [];
    for (let i = 0; i <= bounds.length; i++) {
      const isFirst = i === 0;
      const isLast = i === bounds.length;
      const hrLow = isFirst ? 0 : Math.round(primaryHR * bounds[i - 1]);
      const hrHigh = isLast ? null : Math.round(primaryHR * bounds[i]);
      const pct = pctLabels[i];
      zones.push({
        ...ZONE_LABELS[i],
        hrRange: isFirst ? `< ${hrHigh} bpm`
          : isLast ? `> ${hrLow} bpm`
          : `${hrLow} — ${hrHigh} bpm`,
        hrRangeShort: isFirst ? `<${hrHigh}`
          : isLast ? `>${hrLow}`
          : `${hrLow}-${hrHigh}`,
        pctLTHR: isFirst ? `<${pct.high}%`
          : isLast ? `>${pct.low}%`
          : `${pct.low}-${pct.high}%`,
      });
    }
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
 * 根据配速（秒/km）判断所属区间索引 (0=Z1, ..., 5=Z6)
 * COROS 6 区标准，基于乳酸阈配速百分比
 */
function classifyPace(paceSec, thresholdPaceSec) {
  if (!paceSec || !thresholdPaceSec || thresholdPaceSec <= 0) return 2; // default Z3
  const ratio = thresholdPaceSec / paceSec; // >1 = faster than threshold
  if (ratio > 1.12) return 5; // Z6 无氧动力区
  if (ratio > 1.02) return 4; // Z5 速度耐力区
  if (ratio > 0.93) return 3; // Z4 乳酸阈区
  if (ratio > 0.85) return 2; // Z3 有氧动力区
  if (ratio > 0.71) return 1; // Z2 有氧耐力区
  return 0; // Z1 积极恢复区
}

/**
 * 根据心率判断所属区间索引 (0=Z1, ..., 5=Z6)
 * LTHR 模式使用 COROS 6 区标准
 * @param {number} hr - 当前心率
 * @param {number} refHR - 参考心率（LTHR 或 HRmax）
 * @param {string} [mode="lthr"] - "lthr" 或 "hrmax"
 */
function classifyHR(hr, refHR, mode = "lthr") {
  if (!hr || !refHR || refHR <= 0) return 2;
  if (mode === "lthr") {
    // COROS 6 区: <80%, 80-90%, 91-95%, 96-102%, 103-106%, >106%
    const pct = hr / refHR;
    if (pct > 1.06) return 5;   // Z6 >106%
    if (pct > 1.02) return 4;   // Z5 103-106%
    if (pct >= 0.96) return 3;  // Z4 96-102%
    if (pct >= 0.91) return 2;  // Z3 91-95%
    if (pct >= 0.80) return 1;  // Z2 80-90%
    return 0;                     // Z1 < 80%
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
