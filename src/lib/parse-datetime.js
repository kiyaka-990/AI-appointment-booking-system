import {
  DAY_MS,
  addZonedDays,
  isoDate,
  partsInZone,
  startOfZonedDay,
  zonedToInstant
} from './time.js';

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

function clampDay(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function timeFromMatch(rawHour, rawMinute, meridiem) {
  let hour = Number(rawHour);
  const minute = rawMinute ? Number(rawMinute) : 0;
  const marker = meridiem?.toLowerCase();

  if (marker === 'pm' && hour < 12) hour += 12;
  if (marker === 'am' && hour === 12) hour = 0;
  if (!marker && hour >= 1 && hour <= 7) hour += 12; // "at 3" in a clinic = 3pm

  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function extractTime(text) {
  let match = /(\d{1,2})[:.](\d{2})\s*(am|pm)?/i.exec(text);
  if (match) {
    const time = timeFromMatch(match[1], match[2], match[3]);
    if (time) return { ...time, matched: match[0] };
  }

  match = /(\d{1,2})\s*(am|pm)\b/i.exec(text);
  if (match) {
    const time = timeFromMatch(match[1], '0', match[2]);
    if (time) return { ...time, matched: match[0] };
  }

  match = /\bat\s+(\d{1,2})\b/i.exec(text);
  if (match) {
    const time = timeFromMatch(match[1], '0', null);
    if (time) return { ...time, matched: match[0] };
  }

  if (/\bmorning\b/i.test(text)) return { hour: 9, minute: 0, matched: 'morning', vague: true };
  if (/\b(lunchtime|noon|midday)\b/i.test(text)) return { hour: 12, minute: 0, matched: 'noon' };
  if (/\bafternoon\b/i.test(text)) return { hour: 14, minute: 0, matched: 'afternoon', vague: true };
  if (/\b(evening|after work|after 5|after five)\b/i.test(text)) {
    return { hour: 18, minute: 0, matched: 'evening', vague: true };
  }
  return null;
}

/**
 * Parse the customer's free-text date/time into a real instant.
 * Returns null when nothing date-like was found.
 */
export function parseDateTime(text, { timeZone = 'Europe/London', now = Date.now() } = {}) {
  if (!text) return null;
  const input = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const time = extractTime(input);
  const dateOnlyText = time ? input.replace(time.matched.toLowerCase(), ' ') : input;

  const todayStart = startOfZonedDay(now, timeZone);
  const today = partsInZone(now, timeZone);
  let dayOffset = null;
  let explicitDate = null;

  const isoFull = /(\d{4})-(\d{2})-(\d{2})/.exec(dateOnlyText);
  const numericDate = /(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/.exec(dateOnlyText);
  const dayMonthName = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/.exec(dateOnlyText);
  const monthNameDay = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(dateOnlyText);
  const weekdayMatch = /\b(next\s+|this\s+|coming\s+)?(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/.exec(
    dateOnlyText
  );
  const inDays = /\bin\s+(\d{1,2})\s+(day|days|week|weeks)\b/.exec(dateOnlyText);

  if (/\bday after tomorrow\b/.test(dateOnlyText)) dayOffset = 2;
  else if (/\btomorrow\b/.test(dateOnlyText)) dayOffset = 1;
  else if (/\btoday\b|\btonight\b/.test(dateOnlyText)) dayOffset = 0;
  else if (inDays) dayOffset = Number(inDays[1]) * (inDays[2].startsWith('week') ? 7 : 1);
  else if (isoFull) explicitDate = { year: Number(isoFull[1]), month: Number(isoFull[2]), day: Number(isoFull[3]) };
  else if (numericDate) {
    const first = Number(numericDate[1]);
    const second = Number(numericDate[2]);
    let year = numericDate[3] ? Number(numericDate[3]) : today.year;
    if (year < 100) year += 2000;
    // en-GB default: day/month, unless the first number cannot be a day.
    const day = first > 12 && second <= 12 ? first : second;
    const month = first > 12 && second <= 12 ? second : first;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) explicitDate = { year, month, day };
  } else if (dayMonthName && MONTHS[dayMonthName[2]]) {
    explicitDate = {
      year: today.year,
      month: MONTHS[dayMonthName[2]],
      day: Number(dayMonthName[1])
    };
  } else if (monthNameDay && MONTHS[monthNameDay[1]]) {
    explicitDate = {
      year: today.year,
      month: MONTHS[monthNameDay[1]],
      day: Number(monthNameDay[2])
    };
  }

  const hasTime = Boolean(time);
  const hour = time?.hour ?? 9;
  const minute = time?.minute ?? 0;

  if (explicitDate) {
    if (explicitDate.month < 1 || explicitDate.month > 12) return null;
    if (explicitDate.day < 1 || explicitDate.day > 31) return null;
    clampDay(explicitDate.year, explicitDate.month, explicitDate.day);
    const startMs = zonedToInstant({ ...explicitDate, hour, minute }, timeZone);
    return { startMs, hasTime, hasDate: true, vague: Boolean(time?.vague) };
  }

  if (dayOffset !== null) {
    const base = addZonedDays(todayStart, dayOffset, timeZone);
    const parts = partsInZone(base, timeZone);
    const startMs = zonedToInstant({ year: parts.year, month: parts.month, day: parts.day, hour, minute }, timeZone);
    return { startMs, hasTime, hasDate: true, vague: Boolean(time?.vague) };
  }

  if (weekdayMatch) {
    const key = weekdayMatch[2].slice(0, 3);
    const normalisedKey = Object.keys(WEEKDAYS).find((name) => name.startsWith(key)) ?? key;
    const targetDow = WEEKDAYS[normalisedKey];
    if (targetDow !== undefined) {
      const currentDow = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      let delta = (targetDow - currentDow + 7) % 7;
      let candidate = zonedToInstant(
        { year: today.year, month: today.month, day: today.day, hour, minute },
        timeZone
      );
      candidate = addZonedDays(todayStart, delta, timeZone);
      const candidateParts = partsInZone(candidate, timeZone);
      let startMs = zonedToInstant(
        {
          year: candidateParts.year,
          month: candidateParts.month,
          day: candidateParts.day,
          hour,
          minute
        },
        timeZone
      );
      if (startMs <= now) {
        startMs = startMs + 7 * DAY_MS;
        // Rebuild through the timezone helper to survive DST changes.
        const shifted = addZonedDays(startMs, 0, timeZone);
        const shiftedParts = partsInZone(shifted, timeZone);
        startMs = zonedToInstant(
          { year: shiftedParts.year, month: shiftedParts.month, day: shiftedParts.day, hour, minute },
          timeZone
        );
      }
      return { startMs, hasTime, hasDate: true, vague: Boolean(time?.vague) };
    }
  }

  if (hasTime) {
    let startMs = zonedToInstant(
      { year: today.year, month: today.month, day: today.day, hour, minute },
      timeZone
    );
    if (startMs <= now) {
      const tomorrow = addZonedDays(todayStart, 1, timeZone);
      const parts = partsInZone(tomorrow, timeZone);
      startMs = zonedToInstant({ year: parts.year, month: parts.month, day: parts.day, hour, minute }, timeZone);
    }
    return { startMs, hasTime: true, hasDate: false, vague: Boolean(time?.vague) };
  }

  return null;
}

/** Resolve a bare 'YYYY-MM-DD' to the start of that business day. */
export function parseIsoDate(dayIso, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayIso ?? ''));
  if (!match) return null;
  return zonedToInstant(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0 },
    timeZone
  );
}

export { isoDate };
