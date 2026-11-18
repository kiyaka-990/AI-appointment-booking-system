import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const configPath = process.env.CONFIG_PATH
  ? path.resolve(root, process.env.CONFIG_PATH)
  : path.join(root, 'config', 'business.json');

let cached = null;

function readConfig() {
  if (cached) return cached;
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validate(raw);
  cached = raw;
  return cached;
}

function validate(cfg) {
  const problems = [];
  if (!cfg.business?.name) problems.push('business.name is required');
  if (!cfg.business?.timezone) problems.push('business.timezone is required');
  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    problems.push('at least one service is required');
  }
  const ids = new Set();
  for (const service of cfg.services ?? []) {
    if (!service.id) problems.push('every service needs an id');
    if (ids.has(service.id)) problems.push(`duplicate service id: ${service.id}`);
    ids.add(service.id);
    if (!(service.durationMinutes > 0)) problems.push(`service ${service.id} needs durationMinutes > 0`);
  }
  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
}

export function getConfig() {
  return readConfig();
}

export function reloadConfig() {
  cached = null;
  return readConfig();
}

export function business() {
  return getConfig().business;
}

export function calendarRules() {
  const cfg = getConfig();
  // `calendar.timezone` is optional; without this fallback every availability
  // helper would silently use the server's own timezone instead of the
  // business timezone, shifting slots by the local UTC offset.
  return { ...cfg.calendar, timezone: cfg.calendar.timezone ?? cfg.business.timezone };
}

export function policies() {
  return getConfig().policies ?? {};
}

export function notificationSettings() {
  return getConfig().notifications ?? { mode: 'console' };
}

export function reminderRules() {
  return getConfig().reminders ?? [];
}

export function services() {
  return getConfig().services;
}

function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a service from an id, exact name, or alias. Returns null when the
 * request cannot be mapped onto something the business actually offers.
 */
export function findService(input) {
  if (!input) return null;
  const needle = normalise(input);
  if (!needle) return null;
  const list = services();

  const byId = list.find((service) => normalise(service.id) === needle);
  if (byId) return byId;

  const byName = list.find((service) => normalise(service.name) === needle);
  if (byName) return byName;

  for (const service of list) {
    const candidates = [service.name, ...(service.aliases ?? [])].map(normalise);
    if (candidates.some((candidate) => candidate === needle)) return service;
    if (candidates.some((candidate) => candidate.length > 4 && (needle.includes(candidate) || candidate.includes(needle)))) {
      return service;
    }
  }

  // Last resort: match every meaningful token of a short query.
  const tokens = needle.split(' ').filter((token) => token.length > 3);
  if (tokens.length) {
    let best = null;
    let bestScore = 0;
    for (const service of list) {
      const haystack = [service.name, ...(service.aliases ?? []), service.description ?? ''].join(' ').toLowerCase();
      const score = tokens.filter((token) => haystack.includes(token)).length;
      if (score > bestScore) {
        best = service;
        bestScore = score;
      }
    }
    if (bestScore >= Math.max(1, tokens.length - 1)) return best;
  }

  return null;
}

export function publicConfig() {
  const cfg = getConfig();
  return {
    business: {
      id: cfg.business.id,
      name: cfg.business.name,
      industry: cfg.business.industry,
      timezone: cfg.business.timezone,
      locale: cfg.business.locale,
      currency: cfg.business.currency,
      location: cfg.business.location,
      directions: cfg.business.directions ?? null,
      bookingInstructions: cfg.business.bookingInstructions ?? null,
      supportPhone: cfg.business.supportPhone,
      supportEmail: cfg.business.supportEmail
    },
    services: cfg.services.map((service) => ({
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
      price: service.price,
      description: service.description
    })),
    calendar: {
      slotIntervalMinutes: cfg.calendar.slotIntervalMinutes,
      minNoticeMinutes: cfg.calendar.minNoticeMinutes,
      maxAdvanceDays: cfg.calendar.maxAdvanceDays,
      workingHours: cfg.calendar.workingHours
    }
  };
}
