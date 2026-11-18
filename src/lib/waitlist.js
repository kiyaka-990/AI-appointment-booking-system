import { all, get, nowIso, run } from './db.js';
import { business } from './config.js';
import { deliverRows, enqueue } from './notifications.js';
import { renderTemplate } from './templates.js';

/**
 * Waitlist: a customer who cannot find a suitable time leaves their details, and
 * when a booking is cancelled the freed slot is offered to the best match first.
 * Matching is deliberately simple: same service (or any service), and the slot
 * inside their preferred window when they gave one.
 */
const MAX_OFFERS_PER_SLOT = 3;

export function addWaitlist({
  fullName,
  email = null,
  phone = null,
  service = null,
  fromMs = null,
  toMs = null,
  notes = null,
  customerId = null
}) {
  const timestamp = nowIso();
  run(
    `INSERT INTO waitlist
       (customer_id, full_name, email, phone, service_id, service_name, from_ms, to_ms, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
    customerId,
    fullName,
    email,
    phone,
    service?.id ?? null,
    service?.name ?? null,
    fromMs,
    toMs,
    notes,
    timestamp,
    timestamp
  );
  return get('SELECT * FROM waitlist ORDER BY id DESC LIMIT 1');
}

export function listWaitlist({ status = null, limit = 100 } = {}) {
  return all(
    'SELECT * FROM waitlist WHERE (? IS NULL OR status = ?) ORDER BY created_at ASC LIMIT ?',
    status,
    status,
    limit
  );
}

export function leaveWaitlist(id) {
  run("UPDATE waitlist SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'waiting'", nowIso(), id);
  return get('SELECT * FROM waitlist WHERE id = ?', id) ?? null;
}

/** Waiting entries whose window covers the freed slot, oldest first. */
export function waitingFor({ serviceId = null, startMs, endMs, limit = MAX_OFFERS_PER_SLOT }) {
  return all(
    `SELECT * FROM waitlist
      WHERE status = 'waiting'
        AND (service_id IS NULL OR service_id = ?)
        AND (from_ms IS NULL OR from_ms <= ?)
        AND (to_ms IS NULL OR to_ms >= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    serviceId,
    endMs,
    startMs,
    limit
  );
}

/**
 * Called after a cancellation: offer the freed slot to matching waitlisted
 * customers and mark them notified so the same slot is not offered twice.
 */
export async function offerFreedSlot({ appointment, service, tz = business().timezone, now = Date.now() }) {
  if (!appointment) return { matched: 0, notified: 0 };
  const matches = waitingFor({
    serviceId: service?.id ?? appointment.serviceId,
    startMs: appointment.startMs,
    endMs: appointment.endMs ?? appointment.startMs
  });

  let notified = 0;
  for (const entry of matches) {
    const customer = { full_name: entry.full_name, email: entry.email, phone: entry.phone };
    const rendered = renderTemplate('waitlist-available', {
      customer,
      service,
      appointment,
      tz,
      extra: { entry }
    });
    const channel = entry.email ? 'email' : 'sms';
    const row = enqueue({
      channel,
      recipient: entry.email ?? entry.phone,
      template: 'waitlist-available',
      subject: rendered.subject,
      body: rendered.body,
      appointmentId: appointment.id,
      customerId: entry.customer_id,
      dedupeKey: `waitlist-open:${entry.id}:${appointment.id}`
    });
    run("UPDATE waitlist SET status = 'notified', notified_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), entry.id);
    await deliverRows([row?.id], { now });
    notified += 1;
  }

  return { matched: matches.length, notified };
}
