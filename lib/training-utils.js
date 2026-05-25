import { MARATHON_DATE, PHASES } from "./training-constants.js";

export function paceToSeconds(pace) {
  if (!pace) return 0;
  const parts = pace.split(":");
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

export function secondsToPace(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function getAge(birthday) {
  const today = new Date();
  const birth = new Date(birthday);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

export function weeksUntilMarathon() {
  const diff = MARATHON_DATE - new Date();
  return Math.max(0, Math.ceil(diff / (7 * 86400000)));
}

export function getCurrentPhase(weeksLeft) {
  const totalWeeks = 24;
  if (weeksLeft > totalWeeks) {
    return { name: "准备期", startWeek: 0, endWeek: 0, weeklyKm: [45, 60], focus: "建立基础跑量、维持有氧", currentWeek: 0, weeksUntilPlan: weeksLeft - totalWeeks };
  }
  const weekNum = totalWeeks - weeksLeft + 1;
  for (const phase of PHASES) {
    if (weekNum >= phase.startWeek && weekNum <= phase.endWeek) {
      return { ...phase, currentWeek: weekNum };
    }
  }
  return { ...PHASES[PHASES.length - 1], currentWeek: weekNum };
}

export function getCurrentWeekBounds() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  // Monday = 0 (start of week), Sunday = -6
  const daysFromMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const start = new Date(now);
  start.setDate(now.getDate() + daysFromMon);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
