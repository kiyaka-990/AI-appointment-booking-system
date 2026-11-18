export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function offsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` into a real instant. */
export function zonedToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstPass = guess - offsetMs(new Date(guess), timeZone);
  const secondPass = guess - offsetMs(new Date(firstPass), timeZone);
  return secondPass;
}

export function partsInZone(ms, timeZone) {
  return zonedParts(new Date(ms), timeZone);
}

export function weekdayKey(ms, timeZone) {
  return WEEKDAY_KEYS[new Date(ms).getUTCDay() === undefined ? 0 : dayOfWeek(ms, timeZone)];
}

function dayOfWeek(ms, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const label = formatter.format(new Date(ms)).toLowerCase().slice(0, 3);
  const index = WEEKDAY_KEYS.indexOf(label);
  return index === -1 ? 0 : index;
}

export function dayOfWeekKey(ms, timeZone) {
  return WEEKDAY_KEYS[dayOfWeek(ms, timeZone)];
}

/** 'YYYY-MM-DD' for the given instant in the business timezone. */
export function isoDate(ms, timeZone) {
  const parts = zonedParts(new Date(ms), timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Instant for 00:00 of the business-local date containing `ms`. */
export function startOfZonedDay(ms, timeZone) {
  const parts = zonedParts(new Date(ms), timeZone);
  return zonedToInstant({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
}

export function addZonedDays(ms, days, timeZone) {
  const parts = zonedParts(new Date(ms), timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return zonedToInstant(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate()
    },
    timeZone
  );
}

export function parseClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatDate(ms, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(new Date(ms));
}

export function formatTime(ms, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(new Date(ms));
}

export function formatDateTime(ms, timeZone, locale = 'en-GB') {
  return `${formatDate(ms, timeZone, locale)} at ${formatTime(ms, timeZone, locale)}`;
}

export function formatShort(ms, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(new Date(ms));
}

export function minutesToLabel(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}

export function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
