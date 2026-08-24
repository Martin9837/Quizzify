export const nowIso = () => new Date().toISOString();

export const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const addSeconds = (seconds, from = new Date()) => new Date(from.getTime() + seconds * 1000).toISOString();
export const addMinutes = (minutes, from = new Date()) => addSeconds(minutes * 60, from);
export const addHours = (hours, from = new Date()) => addSeconds(hours * 3600, from);
export const addDays = (days, from = new Date()) => addSeconds(days * 86400, from);

export const startOfDay = (date = new Date(), offsetDays = 0) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
};

export const endOfDay = (date = new Date(), offsetDays = 0) => {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
};

export const dayKey = (value) => (toIso(value) || nowIso()).slice(0, 10);

export const secondsBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));

export const isPast = (value) => Boolean(value) && new Date(value).getTime() < Date.now();

/**
 * Next business-day-aware follow-up slot. Keeps AI-proposed dates inside
 * working hours so tasks do not land at 3am on a Sunday.
 */
export function nextBusinessSlot(daysAhead = 1, hourUtc = 15, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}
