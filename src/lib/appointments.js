import { randomBytes } from 'node:crypto';
import {
  all,
  audit,
  get,
  nowIso,
  run,
  transaction
} from './db.js';
import { business, calendarRules, findService, ownerAlertSettings, policies, reminderRules } from './config.js';
import { checkSlot } from './availability.js';
import { guard } from './faults.js';
import { appointmentEvent, publish, publishStaff, staffEvent } from './events.js';
import { flushBridgeOutbox, queueAppointmentEvent } from './bridge.js';
import { channelProvider } from './messaging.js';
import { offerFreedSlot } from './waitlist.js';
import { AppError, ERROR_CODES } from './errors.js';
import { normaliseEmail, normalisePhone } from './crm.js';
import { cancelPendingForAppointment, deliverRows, enqueue } from './notifications.js';
import { renderTemplate, contactFor } from './templates.js';
import { isoDate, MINUTE_MS } from './time.js';

/** Queue the event for the client's own system and deliver it in the background. */
function notifyBridge(event, appointment, customer = null) {
  try {
    queueAppointmentEvent(event, appointment, customer);
    flushBridgeOutbox().catch(() => {});
  } catch (error) {
    console.warn(`[bridge] ${error.message}`);
  }
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newReference() {
  const cfg = business();
  const year = new Date().getFullYear();
  let code = '';
  const bytes = randomBytes(5);
  for (let index = 0; index < 5; index += 1) {
    code += REFERENCE_ALPHABET[bytes[index] % REFERENCE_ALPHABET.length];
  }
  return `${cfg.referencePrefix ?? 'BK'}-${year}-${code}`;
}

export function mapAppointment(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    conversationId: row.conversation_id ?? null,
    serviceId: row.service_id,
    serviceName: row.service_name,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    start: new Date(Number(row.start_ms)).toISOString(),
    end: new Date(Number(row.end_ms)).toISOString(),
    startLocal: row.start_local,
    endLocal: row.end_local,
    status: row.status,
    location: row.location,
    notes: row.notes,
    source: row.source,
    rescheduledFrom: row.rescheduled_from,
    rescheduledTo: row.rescheduled_to,
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getAppointmentById(id) {
  return mapAppointment(get('SELECT * FROM appointments WHERE id = ?', id));
}

export function getAppointmentByReference(reference) {
  if (!reference) return null;
  const clean = String(reference).trim().toUpperCase();
  return mapAppointment(get('SELECT * FROM appointments WHERE upper(reference) = ?', clean));
}

export function activeAppointmentsForCustomer(customerId) {
  return all(
    "SELECT * FROM appointments WHERE customer_id = ? AND status IN ('confirmed','pending') ORDER BY start_ms ASC",
    customerId
  ).map(mapAppointment);
}

export function findActiveAppointmentForContact({ email, phone, reference }) {
  if (reference) {
    const byRef = getAppointmentByReference(reference);
    if (byRef) return byRef;
  }
  const cleanEmail = normaliseEmail(email);
  const cleanPhone = normalisePhone(phone);
  if (!cleanEmail && !cleanPhone) return null;
  const row = get(
    `SELECT a.* FROM appointments a
       JOIN customers c ON c.id = a.customer_id
      WHERE a.status IN ('confirmed','pending')
        AND (c.email = ? OR c.phone = ?)
      ORDER BY a.start_ms ASC
      LIMIT 1`,
    cleanEmail,
    cleanPhone
  );
  return mapAppointment(row);
}

export function listAppointments({ status = null, fromMs = null, toMs = null, limit = 100 } = {}) {
  const rows = all(
    `SELECT a.*, c.full_name, c.email, c.phone
       FROM appointments a
       JOIN customers c ON c.id = a.customer_id
      WHERE (? IS NULL OR a.status = ?)
        AND (? IS NULL OR a.end_ms > ?)
        AND (? IS NULL OR a.start_ms < ?)
      ORDER BY a.start_ms ASC
      LIMIT ?`,
    status,
    status,
    fromMs,
    fromMs,
    toMs,
    toMs,
    limit
  );
  return rows.map((row) => ({
    ...mapAppointment(row),
    customer: { id: row.customer_id, fullName: row.full_name, email: row.email, phone: row.phone }
  }));
}

export function appointmentEvents(appointmentId) {
  return all(
    'SELECT * FROM appointment_events WHERE appointment_id = ? ORDER BY id ASC',
    appointmentId
  );
}

function recordEvent(handle, appointmentId, type, actor, payload) {
  handle
    .prepare(
      'INSERT INTO appointment_events (appointment_id, type, actor, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(appointmentId, type, actor, payload ? JSON.stringify(payload) : null, nowIso());
}

function checkFailureToError(check, service) {
  const messages = {
    UNKNOWN_SERVICE: ERROR_CODES.UNKNOWN_SERVICE,
    INVALID_DATETIME: ERROR_CODES.INVALID_DATETIME,
    PAST: ERROR_CODES.INVALID_DATETIME,
    TOO_SOON: ERROR_CODES.TOO_SOON,
    TOO_FAR_AHEAD: ERROR_CODES.TOO_FAR_AHEAD,
    CLOSED: ERROR_CODES.OUTSIDE_WORKING_HOURS,
    BLACKOUT: ERROR_CODES.OUTSIDE_WORKING_HOURS,
    OUTSIDE_HOURS: ERROR_CODES.OUTSIDE_WORKING_HOURS,
    TAKEN: ERROR_CODES.SLOT_TAKEN
  };
  return new AppError(messages[check.reason] ?? ERROR_CODES.VALIDATION_FAILED, check.message, {
    details: { reason: check.reason, serviceId: service?.id ?? null }
  });
}

function duplicateBookingError(row) {
  return new AppError(
    ERROR_CODES.DUPLICATE_BOOKING,
    `You already have a ${row.service_name} booked (${row.reference}) around that time. I can move or cancel that one instead — just tell me.`,
    { details: { reference: row.reference, startMs: Number(row.start_ms) } }
  );
}

/** Queue the reminder messages for an appointment. */
function scheduleReminders(handle, appointment, customer, now) {
  const tz = business().timezone;
  const queued = [];
  for (const rule of reminderRules()) {
    const at = appointment.startMs - rule.minutesBefore * MINUTE_MS;
    if (at <= now) continue;
    const context = {
      customer: customer.record,
      service: { ...appointment.service, name: appointment.serviceName },
      appointment: { ...appointment, reference: appointment.reference },
      tz
    };
    const rendered = renderTemplate(rule.template ?? `reminder-${rule.id}`, context);
    if (!rendered) continue;
    const timestamp = nowIso();
    handle
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (appointment_id, customer_id, channel, recipient, template, subject, body,
            status, scheduled_for, dedupe_key, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)`
      )
      .run(
        appointment.id,
        customer.record.id,
        rule.channel ?? 'email',
        contactFor(customer.record, rule.channel ?? 'email'),
        rule.template ?? `reminder-${rule.id}`,
        rendered.subject,
        rendered.body,
        new Date(at).toISOString(),
        `reminder:${rule.id}:${appointment.id}`,
        timestamp,
        timestamp
      );
    queued.push({ ruleId: rule.id, at: new Date(at).toISOString() });
  }
  return queued;
}

/** Tell the business owner/staff about a new booking. Never blocks the booking. */
let warnedOwnerAlert = false;

function enqueueOwnerAlert(handle, appointment, customer, { channel, notes }) {
  const { phone, channel: alertChannel } = ownerAlertSettings();
  if (!phone) return null;
  if (channelProvider(alertChannel) === 'console') {
    if (!warnedOwnerAlert) {
      warnedOwnerAlert = true;
      console.warn(
        `[notify] OWNER_PHONE is set but no ${alertChannel} provider is configured - owner alerts will not be sent.`
      );
    }
    return null;
  }

  const cfg = business();
  const rendered = renderTemplate('owner-alert', {
    customer: customer.record,
    service: { ...appointment.service, name: appointment.serviceName },
    appointment,
    tz: cfg.timezone,
    extra: { channel, notes }
  });
  const timestamp = nowIso();
  handle
    .prepare(
      `INSERT OR IGNORE INTO outbox
         (appointment_id, customer_id, channel, recipient, template, subject, body,
          status, scheduled_for, dedupe_key, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'owner-alert', ?, ?, 'pending', ?, ?, 0, ?, ?)`
    )
    .run(
      appointment.id,
      customer.record.id,
      alertChannel,
      phone,
      rendered.subject,
      rendered.body,
      timestamp,
      `owner-alert:${appointment.id}`,
      timestamp,
      timestamp
    );
  return handle.prepare('SELECT id FROM outbox WHERE dedupe_key = ?').get(`owner-alert:${appointment.id}`)?.id ?? null;
}

function enqueueOwnerNotice(handle, appointment, customer, { channel = 'booking', notes = null } = {}) {
  const cfg = business();
  const rendered = renderTemplate('owner-booking', {
    customer: customer.record,
    service: { ...appointment.service, name: appointment.serviceName },
    appointment,
    tz: cfg.timezone,
    extra: { channel, notes }
  });
  const timestamp = nowIso();
  handle
    .prepare(
      `INSERT OR IGNORE INTO outbox
         (appointment_id, customer_id, channel, recipient, template, subject, body,
          status, scheduled_for, dedupe_key, attempts, created_at, updated_at)
       VALUES (?, ?, 'email', ?, 'owner-booking', ?, ?, 'pending', ?, ?, 0, ?, ?)`
    )
    .run(
      appointment.id,
      customer.record.id,
      cfg.supportEmail,
      rendered.subject,
      rendered.body,
      timestamp,
      `owner-booking:${appointment.id}`,
      timestamp,
      timestamp
    );
  const emailId =
    handle.prepare('SELECT id FROM outbox WHERE dedupe_key = ?').get(`owner-booking:${appointment.id}`)?.id ?? null;
  const alertId = enqueueOwnerAlert(handle, appointment, customer, { channel, notes });
  return { emailId, alertId };
}

function enqueueConfirmation(handle, appointment, customer) {
  const tz = business().timezone;
  const rendered = renderTemplate('confirmation', {
    customer: customer.record,
    service: { ...appointment.service, name: appointment.serviceName },
    appointment,
    tz
  });
  const timestamp = nowIso();
  handle
    .prepare(
      `INSERT INTO outbox
         (appointment_id, customer_id, channel, recipient, template, subject, body,
          status, scheduled_for, dedupe_key, attempts, created_at, updated_at)
       VALUES (?, ?, 'email', ?, 'confirmation', ?, ?, 'pending', ?, ?, 0, ?, ?)`
    )
    .run(
      appointment.id,
      customer.record.id,
      customer.record.email,
      rendered.subject,
      rendered.body,
      timestamp,
      `confirmation:${appointment.id}`,
      timestamp,
      timestamp
    );
  return handle.prepare('SELECT * FROM outbox WHERE dedupe_key = ?').get(`confirmation:${appointment.id}`);
}

/**
 * Outbox templates that belong to the appointment lifecycle and must not
 * outlive it. Reminder templates come from configuration, so a business with
 * custom reminder rules still gets every stale reminder cancelled when a
 * booking is cancelled or moved.
 */
function lifecycleTemplates() {
  return [
    'confirmation',
    ...reminderRules().map((rule) => String(rule.template ?? `reminder-${rule.id}`))
  ];
}

/** Create an appointment. Availability is re-verified inside the write
 * transaction, so two simultaneous requests can never both succeed. */
export function createAppointment({
  customer,
  service,
  startMs,
  notes = null,
  source = 'web-chat',
  idempotencyKey = null,
  conversationId = null,
  actor = 'ai-agent',
  now = Date.now(),
  ignoreAvailability = false
}) {
  const cfg = business();
  const rules = calendarRules();
  const tz = cfg.timezone;
  const policy = policies();

  if (!customer?.id) {
    throw new AppError(ERROR_CODES.MISSING_INFORMATION, 'I need your contact details before I can book.', {
      details: { fields: ['fullName', 'email', 'phone'] }
    });
  }
  const resolved = service?.id ? service : findService(service);
  if (!resolved) {
    throw new AppError(ERROR_CODES.UNKNOWN_SERVICE, 'I could not match that request to a service we offer.');
  }
  if (!Number.isFinite(startMs)) {
    throw new AppError(ERROR_CODES.INVALID_DATETIME, 'I need a specific date and time to check.');
  }

  if (idempotencyKey) {
    const existing = get('SELECT * FROM appointments WHERE idempotency_key = ?', idempotencyKey);
    if (existing) {
      return { appointment: mapAppointment(existing), created: false, replayed: true, deliveries: [] };
    }
  }

  // Advisory duplicate check before the availability check so a customer who
  // re-requests their own slot is told about their existing booking instead of
  // being told the time is taken by someone else. The authoritative check runs
  // again inside the write transaction below, where concurrent requests are
  // serialised by the database lock.
  const windowMs = (policy.duplicateWindowMinutes ?? 1440) * MINUTE_MS;
  const duplicate = get(
    `SELECT * FROM appointments
      WHERE customer_id = ? AND status IN ('confirmed','pending')
        AND (start_ms = ? OR (service_id = ? AND start_ms BETWEEN ? AND ?))
      LIMIT 1`,
    customer.id,
    startMs,
    resolved.id,
    startMs - windowMs,
    startMs + windowMs
  );
  if (duplicate) {
    throw duplicateBookingError(duplicate);
  }

  if (!ignoreAvailability) {
    const check = checkSlot({ startMs, service: resolved, now, timeZone: tz, rules });
    if (!check.available) throw checkFailureToError(check, resolved);
  }

  const endMs = startMs + resolved.durationMinutes * MINUTE_MS;
  const reference = newReference();

  let result;
  try {
    result = transaction((handle) => {
      guard('calendar.write');

      // Authoritative re-checks while the write lock is held: idempotency
      // replay, per-customer duplicates and limits, and the calendar clash.
      // Two requests that pass the advisory checks above cannot both commit.
      if (idempotencyKey) {
        const existing = handle
          .prepare('SELECT * FROM appointments WHERE idempotency_key = ?')
          .get(idempotencyKey);
        if (existing) return { appointment: mapAppointment(existing), created: false, replayed: true, deliveries: [] };
      }

      const duplicateRow = handle
        .prepare(
          `SELECT * FROM appointments
            WHERE customer_id = ? AND status IN ('confirmed','pending')
              AND (start_ms = ? OR (service_id = ? AND start_ms BETWEEN ? AND ?))
            LIMIT 1`
        )
        .get(customer.id, startMs, resolved.id, startMs - windowMs, startMs + windowMs);
      if (duplicateRow) throw duplicateBookingError(duplicateRow);

      const activeCount = handle
        .prepare(
          "SELECT COUNT(*) AS c FROM appointments WHERE customer_id = ? AND status IN ('confirmed','pending')"
        )
        .get(customer.id);
      if (Number(activeCount.c) >= (policy.maxActiveBookingsPerCustomer ?? 3)) {
        throw new AppError(
          ERROR_CODES.DUPLICATE_BOOKING,
          `You already have ${activeCount.c} upcoming appointments. Please call us on ${cfg.supportPhone} to arrange anything further.`
        );
      }

      const clash = handle
        .prepare(
          "SELECT id FROM appointments WHERE status IN ('confirmed','pending') AND start_ms < ? AND end_ms > ? LIMIT 1"
        )
        .get(endMs, startMs);
      if (clash) {
        throw new AppError(ERROR_CODES.SLOT_TAKEN, 'Someone else just took that slot, so nothing has been booked.');
      }

      const id = `apt_${randomBytes(8).toString('hex')}`;
      const timestamp = nowIso();
      handle
        .prepare(
          `INSERT INTO appointments
             (id, reference, customer_id, conversation_id, service_id, service_name,
              start_ms, end_ms, start_local, end_local, status, location, notes, source,
              idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          reference,
          customer.id,
          conversationId,
          resolved.id,
          resolved.name,
          startMs,
          endMs,
          isoDate(startMs, tz),
          isoDate(endMs, tz),
          cfg.location,
          notes,
          source,
          idempotencyKey,
          timestamp,
          timestamp
        );

      recordEvent(handle, id, 'created', actor, { startMs, serviceId: resolved.id, source });
      const created = mapAppointment(handle.prepare('SELECT * FROM appointments WHERE id = ?').get(id));
      created.service = resolved;

      const customerContext = { record: customer };
      scheduleReminders(handle, created, customerContext, now);

      const confirmation = enqueueConfirmation(handle, created, customerContext);
      const ownerNotice = enqueueOwnerNotice(handle, created, customerContext, { channel: source, notes });
      return {
        appointment: created,
        created: true,
        replayed: false,
        confirmationId: confirmation?.id ?? null,
        ownerNoticeId: ownerNotice.emailId,
        ownerAlertId: ownerNotice.alertId
      };
    });
  } catch (error) {
    // Belt and braces for a writer that bypasses the checks above (another
    // process or tool inserting rows directly): report the database-level
    // uniqueness failure as the same friendly domain errors.
    if (/UNIQUE constraint failed: appointments\.start_ms/.test(error?.message ?? '')) {
      throw new AppError(ERROR_CODES.SLOT_TAKEN, 'Someone else just took that slot, so nothing has been booked.');
    }
    if (idempotencyKey && /UNIQUE constraint failed: appointments\.idempotency_key/.test(error?.message ?? '')) {
      const existing = get('SELECT * FROM appointments WHERE idempotency_key = ?', idempotencyKey);
      if (existing) {
        return { appointment: mapAppointment(existing), created: false, replayed: true, deliveries: [] };
      }
    }
    throw error;
  }

  if (result.replayed) {
    return { appointment: result.appointment, created: false, replayed: true, deliveries: [] };
  }

  audit('appointment.created', {
    actor,
    entity: 'appointment',
    entityId: result.appointment.id,
    detail: { reference, start: result.appointment.start, service: resolved.id, source }
  });

  publish(conversationId, appointmentEvent(result.appointment, 'confirmed'));
  publishStaff(
    staffEvent(result.appointment, 'created', { customerName: customer.full_name ?? null })
  );
  notifyBridge('created', result.appointment, customer);

  return {
    appointment: result.appointment,
    created: true,
    replayed: false,
    deliveries: [result.confirmationId, result.ownerNoticeId, result.ownerAlertId]
  };
}

export async function cancelAppointment({ reference, appointment = null, reason = null, actor = 'ai-agent', now = Date.now() }) {
  const target = appointment ?? getAppointmentByReference(reference);
  if (!target) {
    throw new AppError(ERROR_CODES.BOOKING_NOT_FOUND, 'I could not find a booking with that reference.');
  }
  if (target.status === 'cancelled') {
    throw new AppError(ERROR_CODES.BOOKING_ALREADY_CANCELLED, 'That appointment is already cancelled.');
  }

  const customerRow = get('SELECT * FROM customers WHERE id = ?', target.customerId);
  const service = findService(target.serviceId) ?? { id: target.serviceId, name: target.serviceName };

  const confirmationId = transaction((handle) => {
    const timestamp = nowIso();
    handle
      .prepare(
        "UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?"
      )
      .run(timestamp, reason, timestamp, target.id);
    recordEvent(handle, target.id, 'cancelled', actor, { reason });
    return null;
  });

  cancelPendingForAppointment(target.id, { templates: lifecycleTemplates() });

  const rendered = renderTemplate('cancellation', {
    customer: customerRow,
    service,
    appointment: target,
    tz: business().timezone,
    extra: { reason }
  });
  const row = enqueue({
    channel: 'email',
    recipient: customerRow?.email,
    template: 'cancellation',
    subject: rendered.subject,
    body: rendered.body,
    appointmentId: target.id,
    customerId: target.customerId,
    dedupeKey: `cancellation:${target.id}`
  });

  audit('appointment.cancelled', {
    actor,
    entity: 'appointment',
    entityId: target.id,
    detail: { reference: target.reference, reason }
  });

  publish(target.conversationId, appointmentEvent(target, 'cancelled'));
  publishStaff(staffEvent(target, 'cancelled', { customerName: customerRow?.full_name ?? null }));
  notifyBridge('cancelled', { ...target, status: 'cancelled' }, customerRow);

  // The freed slot goes to whoever is waiting for it.
  try {
    await offerFreedSlot({
      appointment: { ...target, status: 'cancelled' },
      service,
      tz: business().timezone,
      now
    });
  } catch (error) {
    console.warn(`[waitlist] could not offer the freed slot: ${error.message}`);
  }

  await deliverRows([row?.id]);

  return { appointment: getAppointmentById(target.id), notification: row?.id ?? confirmationId };
}

export async function rescheduleAppointment({ reference, appointment = null, startMs, actor = 'ai-agent', now = Date.now() }) {
  const target = appointment ?? getAppointmentByReference(reference);
  if (!target) {
    throw new AppError(ERROR_CODES.BOOKING_NOT_FOUND, 'I could not find a booking with that reference.');
  }
  if (target.status !== 'confirmed' && target.status !== 'pending') {
    throw new AppError(ERROR_CODES.BOOKING_ALREADY_CANCELLED, 'That appointment is not active, so it cannot be moved.');
  }

  const service = findService(target.serviceId) ?? {
    id: target.serviceId,
    name: target.serviceName,
    durationMinutes: Math.round((target.endMs - target.startMs) / MINUTE_MS)
  };
  const tz = business().timezone;
  const check = checkSlot({
    startMs,
    service,
    now,
    timeZone: tz,
    ignoreAppointmentId: target.id
  });
  if (!check.available) throw checkFailureToError(check, service);

  const customerRow = get('SELECT * FROM customers WHERE id = ?', target.customerId);
  const previousStartMs = target.startMs;
  const endMs = startMs + service.durationMinutes * MINUTE_MS;

  transaction((handle) => {
    guard('calendar.write');
    const clash = handle
      .prepare(
        "SELECT id FROM appointments WHERE status IN ('confirmed','pending') AND start_ms < ? AND end_ms > ? AND id <> ? LIMIT 1"
      )
      .get(endMs, startMs, target.id);
    if (clash) {
      throw new AppError(ERROR_CODES.SLOT_TAKEN, 'Someone else just took that slot, so nothing has been moved.');
    }

    // Keep a lightweight audit chain on the appointment itself.
    handle
      .prepare(
        `UPDATE appointments
            SET start_ms = ?, end_ms = ?, start_local = ?, end_local = ?,
                rescheduled_from = ?, status = 'confirmed', updated_at = ?
          WHERE id = ?`
      )
      .run(
        startMs,
        endMs,
        isoDate(startMs, tz),
        isoDate(endMs, tz),
        new Date(previousStartMs).toISOString(),
        nowIso(),
        target.id
      );
    recordEvent(handle, target.id, 'rescheduled', actor, { from: previousStartMs, to: startMs });
  });

  cancelPendingForAppointment(target.id, { templates: lifecycleTemplates() });

  const updated = getAppointmentById(target.id);
  const context = {
    customer: customerRow,
    service: { ...service },
    appointment: updated,
    tz,
    extra: { previousStartMs }
  };

  const rendered = renderTemplate('reschedule', context);
  const notification = enqueue({
    channel: 'email',
    recipient: customerRow?.email,
    template: 'reschedule',
    subject: rendered.subject,
    body: rendered.body,
    appointmentId: updated.id,
    customerId: updated.customerId,
    dedupeKey: `reschedule:${updated.id}:${startMs}`
  });

  // Re-arm reminders for the new time.
  for (const rule of reminderRules()) {
    const at = startMs - rule.minutesBefore * MINUTE_MS;
    if (at <= now) continue;
    const reminder = renderTemplate(rule.template ?? `reminder-${rule.id}`, {
      ...context,
      appointment: updated
    });
    enqueue({
      channel: rule.channel ?? 'email',
      recipient: contactFor(customerRow, rule.channel ?? 'email'),
      template: rule.template ?? `reminder-${rule.id}`,
      subject: reminder.subject,
      body: reminder.body,
      scheduledFor: new Date(at).toISOString(),
      appointmentId: updated.id,
      customerId: updated.customerId,
      dedupeKey: `reminder:${rule.id}:${updated.id}:${startMs}`
    });
  }

  audit('appointment.rescheduled', {
    actor,
    entity: 'appointment',
    entityId: updated.id,
    detail: { reference: updated.reference, from: previousStartMs, to: startMs }
  });

  publish(updated.conversationId, appointmentEvent(updated, 'rescheduled'));
  publishStaff(
    staffEvent(updated, 'rescheduled', {
      customerName: customerRow?.full_name ?? null,
      previousStartMs
    })
  );
  notifyBridge('rescheduled', updated, customerRow);

  await deliverRows([notification?.id]);

  return { appointment: getAppointmentById(target.id), previousStartMs, notification: notification?.id ?? null };
}

export function remindersFor(appointmentId) {
  return all('SELECT * FROM outbox WHERE appointment_id = ? ORDER BY scheduled_for ASC', appointmentId);
}
