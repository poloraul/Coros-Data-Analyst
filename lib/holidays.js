/**
 * 中国法定节假日数据（2026年）
 *
 * 只包含实际假期日期，不包含调休上班日。
 * 来源：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）
 *
 * 训练周期（2026年6月~12月）涉及的节日：
 *   - 端午节 6/19~6/21
 *   - 中秋节 9/25~9/27
 *   - 国庆节 10/1~10/7
 */

const HOLIDAYS_2026 = [
  // 元旦（1月）
  { name: "元旦", dates: ["2026-01-01", "2026-01-02", "2026-01-03"] },
  // 春节（2月）
  { name: "春节", dates: ["2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23"] },
  // 清明节（4月）
  { name: "清明节", dates: ["2026-04-04", "2026-04-05", "2026-04-06"] },
  // 劳动节（5月）
  { name: "劳动节", dates: ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"] },
  // 端午节（6月）
  { name: "端午节", dates: ["2026-06-19", "2026-06-20", "2026-06-21"] },
  // 中秋节（9月）
  { name: "中秋节", dates: ["2026-09-25", "2026-09-26", "2026-09-27"] },
  // 国庆节（10月）
  { name: "国庆节", dates: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"] },
];

/**
 * 获取指定日期范围内（YYYY-MM-DD格式）的节假日列表
 * @param {string} startDate 起始日期，如 "2026-06-01"
 * @param {string} endDate 结束日期，如 "2026-06-15"
 * @returns {Array<{date: string, name: string}>} 节假日列表
 */
export function getHolidaysInRange(startDate, endDate) {
  const result = [];
  for (const holiday of HOLIDAYS_2026) {
    for (const date of holiday.dates) {
      if (date >= startDate && date <= endDate) {
        result.push({ date, name: holiday.name });
      }
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 判断指定日期是否为法定节假日
 * @param {string} dateStr 日期 YYYY-MM-DD
 * @returns {{isHoliday: boolean, holidayName?: string}}
 */
export function isHoliday(dateStr) {
  for (const holiday of HOLIDAYS_2026) {
    if (holiday.dates.includes(dateStr)) {
      return { isHoliday: true, holidayName: holiday.name };
    }
  }
  return { isHoliday: false };
}

/**
 * 获取 weekDays 数组中每天对应的节假日信息
 * @param {string[]} weekDays 日期数组 ["2026-06-15", ...]
 * @returns {string} 格式化文本：如 "周三 2026-06-17 中秋节" 或空字符串
 */
export function getHolidayAnnotations(weekDays) {
  const annotations = [];
  for (const dateStr of weekDays) {
    const h = isHoliday(dateStr);
    if (h.isHoliday) {
      const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const d = new Date(dateStr);
      const dayName = dayNames[d.getDay()];
      annotations.push(`${dayName} ${dateStr}：${h.holidayName}`);
    }
  }
  return annotations.length > 0 ? `本周处于以下节假日中：\n${annotations.join("\n")}\n节假日当天可以安排节奏跑、间歇跑或LSD等强度课。` : "";
}
