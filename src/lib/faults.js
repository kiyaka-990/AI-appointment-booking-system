import { AppError, ERROR_CODES } from './errors.js';

/**
 * Fault injection used by the demo and the test suite to prove the workflow
 * degrades safely when a downstream system fails.
 *
 * Available switches:
 *   calendar.read   availability lookups fail
 *   calendar.write  appointment inserts/updates fail
 *   crm             customer writes fail
 *   notifications   confirmation/reminder delivery fails
 *   ai              forced use of the deterministic fallback assistant
 */
const switches = new Map();
const failureCounters = new Map();

export const FAULT_KEYS = ['calendar.read', 'calendar.write', 'crm', 'notifications', 'ai'];

export function setFault(key, value) {
  if (!FAULT_KEYS.includes(key)) throw new Error(`Unknown fault key: ${key}`);
  switches.set(key, Boolean(value));
  if (!value) failureCounters.delete(key);
}

export function setFaults(map = {}) {
  for (const [key, value] of Object.entries(map)) setFault(key, value);
  return listFaults();
}

export function listFaults() {
  const result = {};
  for (const key of FAULT_KEYS) result[key] = Boolean(switches.get(key));
  return result;
}

export function isFaulty(key) {
  return Boolean(switches.get(key));
}

export function resetFaults() {
  switches.clear();
  failureCounters.clear();
}

const MESSAGES = {
  'calendar.read': new AppError(
    ERROR_CODES.CALENDAR_UNAVAILABLE,
    'I cannot reach the booking calendar right now, so I am not going to guess at availability.',
    { retryable: true, status: 503, technicalMessage: 'calendar read failed (injected)' }
  ),
  'calendar.write': new AppError(
    ERROR_CODES.CALENDAR_UNAVAILABLE,
    'The calendar rejected the booking just now, so nothing has been booked.',
    { retryable: true, status: 503, technicalMessage: 'calendar write failed (injected)' }
  ),
  crm: new AppError(
    ERROR_CODES.CRM_UNAVAILABLE,
    'I could not save your details to our customer record, so I have not confirmed the booking.',
    { retryable: true, status: 503, technicalMessage: 'CRM write failed (injected)' }
  ),
  notifications: new AppError(
    ERROR_CODES.NOTIFICATION_FAILED,
    'The booking was saved but the confirmation message could not be delivered yet.',
    { retryable: true, status: 503, technicalMessage: 'notification delivery failed (injected)' }
  )
};

/**
 * Raise the injected error for a dependency. `count` lets a caller consume a
 * limited number of failures, which is how retry paths are tested.
 */
export function guard(key) {
  if (!switches.get(key)) return;
  if (key === 'ai') return;
  const error = MESSAGES[key];
  failureCounters.set(key, (failureCounters.get(key) ?? 0) + 1);
  throw new AppError(error.code, error.userMessage, {
    retryable: true,
    status: error.status,
    technicalMessage: error.message
  });
}

export function faultStats() {
  return Object.fromEntries(failureCounters.entries());
}
