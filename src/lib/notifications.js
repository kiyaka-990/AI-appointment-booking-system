import { all, get, nowIso, run } from './db.js';
import { notificationSettings } from './config.js';
import { guard } from './faults.js';
import { channelProvider, deliverMessage, messagingConfig } from './messaging.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
/** A claim older than this belongs to a worker that died mid-send. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export function deliveryMode() {
  const settings = notificationSettings();
  return messagingConfig().mode ?? settings.mode ?? 'auto';
}

export function enqueue({
  channel = 'email',
  recipient = null,
  template,
  subject = null,
  body,
  scheduledFor = nowIso(),
  dedupeKey = null,
  appointmentId = null,
  customerId = null
}) {
  const timestamp = nowIso();
  run(
    `INSERT OR IGNORE INTO outbox
       (appointment_id, customer_id, channel, recipient, template, subject, body,
        status, scheduled_for, dedupe_key, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)`,
    appointmentId,
    customerId,
    channel,
    recipient,
    template,
    subject,
    body,
    scheduledFor,
    dedupeKey,
    timestamp,
    timestamp
  );
  if (dedupeKey) {
    return get('SELECT * FROM outbox WHERE dedupe_key = ?', dedupeKey);
  }
  return get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
}

export function getOutboxRow(id) {
  return get('SELECT * FROM outbox WHERE id = ?', id) ?? null;
}

/**
 * Atomically claim a row before sending. Two concurrent workers (a cron tick
 * and a manual "process due queue" click) cannot both send the same message:
 * only the caller whose UPDATE matches a pending row owns the delivery.
 */
function claimOutboxRow(id) {
  const { changes } = run(
    "UPDATE outbox SET status = 'processing', updated_at = ? WHERE id = ? AND status IN ('pending','failed')",
    nowIso(),
    id
  );
  return changes > 0;
}

async function providerSend(row) {
  const provider = channelProvider(row.channel);
  if (provider === 'console') {
    if (process.env.NOTIFY_SILENT !== '1') {
      console.log(`  [notify:${row.channel}] -> ${row.recipient ?? 'unknown'} :: ${row.subject ?? row.template}`);
    }
    return { ok: true, provider: 'console' };
  }

  const result = await deliverMessage({
    channel: row.channel,
    to: row.recipient,
    subject: row.subject,
    text: row.body
  });
  return { ok: true, provider: result.provider, id: result.id };
}

/** One delivery attempt with retry bookkeeping. */
export async function attemptDelivery(id, { now = Date.now() } = {}) {
  const row = getOutboxRow(id);
  if (!row) return { ok: false, error: 'outbox row not found' };
  if (row.status === 'sent' || row.status === 'cancelled') {
    return { ok: row.status === 'sent', skipped: true, row };
  }
  if (!claimOutboxRow(id)) {
    // Another worker holds the claim and owns the outcome for this attempt.
    return { ok: false, skipped: true, reason: 'in-flight', row: getOutboxRow(id) };
  }

  try {
    guard('notifications');
    const result = await providerSend(row);
    if (!result.ok) throw new Error(result.error ?? 'delivery failed');
    run(
      "UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?",
      nowIso(),
      nowIso(),
      id
    );
    return { ok: true, row: getOutboxRow(id) };
  } catch (error) {
    const attempts = Number(row.attempts) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
    const nextAt = new Date(now + backoff * 60 * 1000).toISOString();
    // Back to pending (or failed after the last attempt), which also releases
    // the claim so the next worker tick can retry.
    run(
      `UPDATE outbox
          SET status = ?, attempts = ?, last_error = ?, scheduled_for = ?, updated_at = ?
        WHERE id = ?`,
      failed ? 'failed' : 'pending',
      attempts,
      String(error.message).slice(0, 500),
      failed ? row.scheduled_for : nextAt,
      nowIso(),
      id
    );
    return { ok: false, error: error.message, attempts, retryAt: failed ? null : nextAt };
  }
}

/** Deliver a batch of rows now (used right after a booking event). */
export async function deliverRows(ids, options = {}) {
  const results = [];
  for (const id of ids.filter(Boolean)) {
    results.push({ id, ...(await attemptDelivery(id, options)) });
  }
  return results;
}

/** Worker tick: pick up everything that is due. */
export async function processOutbox({ now = Date.now(), limit = 50 } = {}) {
  // Release claims left behind by a worker that died mid-send, so their rows
  // are picked up again. A live claim is always younger than this.
  run(
    "UPDATE outbox SET status = 'pending', updated_at = ? WHERE status = 'processing' AND updated_at <= ?",
    nowIso(),
    new Date(now - STALE_CLAIM_MS).toISOString()
  );
  const due = all(
    "SELECT id FROM outbox WHERE status = 'pending' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT ?",
    new Date(now).toISOString(),
    limit
  );
  const results = [];
  for (const row of due) {
    results.push({ id: row.id, ...(await attemptDelivery(row.id, { now })) });
  }
  return { processed: results.length, results };
}

export function cancelPendingForAppointment(appointmentId, { templates = null } = {}) {
  const timestamp = nowIso();
  if (templates?.length) {
    const placeholders = templates.map(() => '?').join(', ');
    run(
      `UPDATE outbox SET status = 'cancelled', updated_at = ?
        WHERE appointment_id = ? AND status = 'pending' AND template IN (${placeholders})`,
      timestamp,
      appointmentId,
      ...templates
    );
    return;
  }
  run(
    "UPDATE outbox SET status = 'cancelled', updated_at = ? WHERE appointment_id = ? AND status = 'pending'",
    timestamp,
    appointmentId
  );
}

export function listOutbox({ status = null, appointmentId = null, limit = 100 } = {}) {
  return all(
    `SELECT o.*, a.reference
       FROM outbox o
       LEFT JOIN appointments a ON a.id = o.appointment_id
      WHERE (? IS NULL OR o.status = ?)
        AND (? IS NULL OR o.appointment_id = ?)
      ORDER BY o.id DESC
      LIMIT ?`,
    status,
    status,
    appointmentId,
    appointmentId,
    limit
  );
}
