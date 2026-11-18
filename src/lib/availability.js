import { calendarRules, findService } from './config.js';
import { all } from './db.js';
import { guard } from './faults.js';
import {
  addZonedDays,
  dayOfWeekKey,
  formatShort,
  isoDate,
  overlap,
  parseClockTime,
  partsInZone,
  startOfZonedDay,
  MINUTE_MS,
  DAY_MS,
  zonedToInstant
} from './time.js';

const ACTIVE_STATUSES = "('confirmed', 'pending')";

/** Raw appointments that could collide with the window. */
export function busyIntervals(fromMs, toMs, { ignoreAppointmentId = null } = {}) {
  guard('calendar.read');
  const rows = all(
    `SELECT id, start_ms, end_ms, service_name, status
       FROM appointments
      WHERE status IN ${ACTIVE_STATUSES}
        AND end_ms > ? AND start_ms < ?
        AND (? IS NULL OR id <> ?)`,
    fromMs,
    toMs,
    ignoreAppointmentId,
    ignoreAppointmentId
  );
  return rows.map((row) => ({
    id: row.id,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    serviceName: row.service_name
  }));
}

function blockedBy(rows, startMs, endMs, rules) {
  const before = (rules.bufferBeforeMinutes ?? 0) * MINUTE_MS;
  const after = (rules.bufferAfterMinutes ?? 0) * MINUTE_MS;
  return (
    rows.find((row) =>
      overlap(startMs, endMs, row.startMs - before, row.endMs + after)
    ) ?? null
  );
}

function parseDayIso(dayIso, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayIso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const noon = zonedToInstant({ year, month, day, hour: 12 }, timeZone);
  return { year, month, day, noon };
}

/**
 * All candidate slots for one business-local day, already filtered for
 * working hours, notice windows, blackout dates and existing appointments.
 */
export function slotsForDay({ dayIso, service, now = Date.now(), timeZone, rules = calendarRules() }) {
  const tz = timeZone ?? rules.timezone;
  if (!service) return [];
  const parsed = parseDayIso(dayIso, tz);
  if (!parsed) return [];

  if ((rules.blackoutDates ?? []).includes(dayIso)) return [];

  const weekday = dayOfWeekKey(parsed.noon, tz);
  const windows = rules.workingHours?.[weekday] ?? [];
  if (!windows.length) return [];

  const step = (rules.slotIntervalMinutes ?? 15) * MINUTE_MS;
  const duration = service.durationMinutes * MINUTE_MS;
  const earliest = now + (rules.minNoticeMinutes ?? 0) * MINUTE_MS;
  const latest = now + (rules.maxAdvanceDays ?? 60) * DAY_MS;

  const dayStart = startOfZonedDay(parsed.noon, tz);
  const dayEnd = dayStart + DAY_MS;
  const busy = busyIntervals(dayStart - DAY_MS, dayEnd + DAY_MS);

  const slots = [];
  for (const [openText, closeText] of windows) {
    const open = parseClockTime(openText);
    const close = parseClockTime(closeText);
    if (!open || !close) continue;
    const windowStart = zonedToInstant(
      { year: parsed.year, month: parsed.month, day: parsed.day, ...open },
      tz
    );
    const windowEnd = zonedToInstant(
      { year: parsed.year, month: parsed.month, day: parsed.day, ...close },
      tz
    );
    for (let start = windowStart; start + duration <= windowEnd; start += step) {
      const end = start + duration;
      if (start < earliest || start > latest) continue;
      if (blockedBy(busy, start, end, rules)) continue;
      slots.push({ startMs: start, endMs: end, label: formatShort(start, tz) });
    }
  }
  return slots;
}

/**
 * Authoritative availability check for one exact start time.
 * Returns a reason when the slot cannot be used so the agent can explain why.
 */
export function checkSlot({ startMs, service, now = Date.now(), timeZone, rules = calendarRules(), ignoreAppointmentId = null }) {
  const tz = timeZone ?? rules.timezone;
  if (!service) {
    return { available: false, reason: 'UNKNOWN_SERVICE', message: 'That service is not offered here.' };
  }
  if (!Number.isFinite(startMs)) {
    return { available: false, reason: 'INVALID_DATETIME', message: 'I could not understand that date and time.' };
  }

  const duration = service.durationMinutes * MINUTE_MS;
  const endMs = startMs + duration;
  const earliest = now + (rules.minNoticeMinutes ?? 0) * MINUTE_MS;

  if (startMs < now) {
    return { available: false, reason: 'PAST', message: 'That time is in the past.', alternativesFrom: now };
  }
  if (startMs < earliest) {
    const minutes = Math.ceil((earliest - startMs) / MINUTE_MS);
    return {
      available: false,
      reason: 'TOO_SOON',
      message: `We need at least ${rules.minNoticeMinutes} minutes notice, so please pick a time at least ${minutes} minutes later.`,
      alternativesFrom: earliest
    };
  }
  if (startMs > now + (rules.maxAdvanceDays ?? 60) * DAY_MS) {
    return {
      available: false,
      reason: 'TOO_FAR_AHEAD',
      message: `I can only book up to ${rules.maxAdvanceDays} days ahead.`,
      alternativesFrom: earliest
    };
  }

  const dayIso = isoDate(startMs, tz);
  if ((rules.blackoutDates ?? []).includes(dayIso)) {
    return {
      available: false,
      reason: 'BLACKOUT',
      message: 'We are closed that day.',
      alternativesFrom: startMs
    };
  }

  const weekday = dayOfWeekKey(startMs, tz);
  const windows = rules.workingHours?.[weekday] ?? [];
  if (!windows.length) {
    return {
      available: false,
      reason: 'CLOSED',
      message: 'We are closed that day.',
      alternativesFrom: startMs
    };
  }

  const parts = partsInZone(startMs, tz);
  const matchesWindow = windows.some(([openText, closeText]) => {
    const open = parseClockTime(openText);
    const close = parseClockTime(closeText);
    if (!open || !close) return false;
    const windowStart = zonedToInstant(
      { year: parts.year, month: parts.month, day: parts.day, ...open },
      tz
    );
    const windowEnd = zonedToInstant(
      { year: parts.year, month: parts.month, day: parts.day, ...close },
      tz
    );
    return startMs >= windowStart && endMs <= windowEnd;
  });

  if (!matchesWindow) {
    return {
      available: false,
      reason: 'OUTSIDE_HOURS',
      message: 'That time is outside our opening hours for that day.',
      alternativesFrom: startMs
    };
  }

  const busy = busyIntervals(startMs - DAY_MS, endMs + DAY_MS, { ignoreAppointmentId });
  const clash = blockedBy(busy, startMs, endMs, rules);
  if (clash) {
    return {
      available: false,
      reason: 'TAKEN',
      message: 'That time is already booked.',
      alternativesFrom: startMs,
      clash
    };
  }

  return { available: true, startMs, endMs, dayIso };
}

/** Highest quality alternatives around a preferred time. */
export function suggestAlternatives({
  service,
  fromMs = Date.now(),
  count = 3,
  now = Date.now(),
  timeZone,
  rules = calendarRules(),
  ignoreAppointmentId = null
}) {
  const tz = timeZone ?? rules.timezone;
  const found = [];
  const searchStart = Math.max(fromMs, now + (rules.minNoticeMinutes ?? 0) * MINUTE_MS);
  let cursor = startOfZonedDay(searchStart, tz);

  for (let day = 0; day < 14 && found.length < count; day += 1) {
    const dayIso = isoDate(cursor, tz);
    const slots = slotsForDay({ dayIso, service, now, timeZone: tz, rules });
    for (const slot of slots) {
      if (found.length >= count) break;
      if (ignoreAppointmentId) {
        const check = checkSlot({
          startMs: slot.startMs,
          service,
          now,
          timeZone: tz,
          rules,
          ignoreAppointmentId
        });
        if (!check.available) continue;
      }
      if (slot.startMs < searchStart) continue;
      if (found.some((existing) => existing.startMs === slot.startMs)) continue;
      found.push(slot);
    }
    cursor = addZonedDays(cursor, 1, tz);
  }

  return found;
}

/** Slots grouped by day for the availability API and the chat widget. */
export function availabilityCalendar({ serviceKey, fromDate, days = 7, now = Date.now(), timeZone }) {
  const service = findService(serviceKey);
  if (!service) return { service: null, days: [] };
  const rules = calendarRules();
  const tz = timeZone ?? rules.timezone;
  const startIso = fromDate ?? isoDate(now, tz);
  const parsed = parseDayIso(startIso, tz);
  if (!parsed) return { service, days: [] };

  const result = [];
  let cursor = parsed.noon;
  for (let index = 0; index < Math.min(days, 60); index += 1) {
    const dayIso = isoDate(cursor, tz);
    const slots = slotsForDay({ dayIso, service, now, timeZone: tz, rules });
    result.push({
      date: dayIso,
      label: new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'long',
        day: 'numeric',
        month: 'short'
      }).format(new Date(cursor)),
      slots: slots.map((slot) => ({
        start: new Date(slot.startMs).toISOString(),
        startMs: slot.startMs,
        end: new Date(slot.endMs).toISOString(),
        label: slot.label
      }))
    });
    cursor = addZonedDays(cursor, 1, tz);
  }

  return { service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes }, days: result };
}

export { isoDate, startOfZonedDay };
