import { all, get, nowIso, run } from './db.js';
import { business, getConfig } from './config.js';

/**
 * The bridge to a client's existing system.
 *
 * This app stays the orchestrator: whenever an appointment is created, moved or
 * cancelled, a signed JSON event is queued and POSTed to whatever the client
 * runs (their PMS, a Google Apps Script, an n8n/Make/Zapier workflow, a Lambda).
 * Delivery is retried with backoff, so an unavailable endpoint delays the event
 * instead of losing it, and reconciliation can repair drift in the other
 * direction (see scripts/reconcile.js).
 */
const MAX_ATTEMPTS = 8;
const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60, 180, 360];

export function bridgeConfig() {
  const section = getConfig().integrations?.webhook ?? {};
  const url = process.env.BRIDGE_WEBHOOK_URL || section.url || '';
  return {
    url,
    token: process.env.BRIDGE_WEBHOOK_TOKEN || section.token || '',
    events: Array.isArray(section.events) ? section.events : ['created', 'rescheduled', 'cancelled'],
    enabled: Boolean(url)
  };
}

function isoFromMs(ms) {
  return Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null;
}

export function buildPayload(event, appointment, customer = null) {
  const cfg = business();
  return {
    event: `appointment.${event}`,
    sentAt: new Date().toISOString(),
    business: { id: cfg.id, name: cfg.name, timezone: cfg.timezone },
    appointment: {
      reference: appointment.reference,
      status: appointment.status,
      serviceId: appointment.serviceId,
      serviceName: appointment.serviceName,
      start: isoFromMs(appointment.startMs),
      end: isoFromMs(appointment.endMs),
      location: appointment.location ?? cfg.location ?? null
    },
    customer: customer
      ? { fullName: customer.full_name ?? customer.fullName ?? null, email: customer.email ?? null, phone: customer.phone ?? null }
      : null
  };
}

/** Queue one event for the client's system. Returns the row, or null if disabled. */
export function queueAppointmentEvent(event, appointment, customer = null) {
  const cfg = bridgeConfig();
  if (!cfg.enabled || !appointment) return null;
  if (!cfg.events.includes(event)) return null;

  const payload = buildPayload(event, appointment, customer);
  const dedupeKey = `${event}:${appointment.id}:${appointment.startMs}:${appointment.status}`;
  const timestamp = nowIso();
  run(
    `INSERT OR IGNORE INTO bridge_outbox
       (event, appointment_id, payload, status, attempts, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    payload.event,
    appointment.id,
    JSON.stringify(payload),
    dedupeKey,
    timestamp,
    timestamp
  );
  return get('SELECT * FROM bridge_outbox WHERE dedupe_key = ?', dedupeKey) ?? null;
}

export function listBridgeOutbox({ status = null, limit = 50 } = {}) {
  return all(
    'SELECT * FROM bridge_outbox WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?',
    status,
    status,
    limit
  );
}

/** One delivery attempt per due row. */
export async function flushBridgeOutbox({ limit = 20, now = Date.now() } = {}) {
  const cfg = bridgeConfig();
  if (!cfg.enabled) return { processed: 0, sent: 0, failed: 0, disabled: true };
  const due = all(
    "SELECT * FROM bridge_outbox WHERE status = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY id ASC LIMIT ?",
    new Date(now).toISOString(),
    limit
  );

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const response = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-event': row.event,
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
        },
        body: row.payload,
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`bridge responded ${response.status}`);
      run(
        "UPDATE bridge_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?",
        nowIso(),
        nowIso(),
        row.id
      );
      sent += 1;
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      run(
        'UPDATE bridge_outbox SET status = ?, attempts = ?, last_error = ?, next_at = ?, updated_at = ? WHERE id = ?',
        giveUp ? 'failed' : 'pending',
        attempts,
        String(error.message).slice(0, 500),
        new Date(now + backoff * 60_000).toISOString(),
        nowIso(),
        row.id
      );
      failed += 1;
    }
  }
  return { processed: due.length, sent, failed };
}

/**
 * Compare our diary with what the client's system reports for the same window.
 * Read-only: the caller decides whether to heal.
 */
export function compareAppointments(local, remote) {
  const remoteByRef = new Map();
  for (const item of remote ?? []) {
    if (item?.reference) remoteByRef.set(String(item.reference).toUpperCase(), item);
  }
  const active = (local ?? []).filter((appointment) => appointment.status === 'confirmed' || appointment.status === 'pending');
  const missingRemotely = [];
  const statusMismatch = [];
  const matched = [];

  for (const appointment of active) {
    const reference = String(appointment.reference).toUpperCase();
    const other = remoteByRef.get(reference);
    if (!other) {
      missingRemotely.push(appointment);
    } else if (String(other.status ?? '').toLowerCase() === 'cancelled') {
      statusMismatch.push({ appointment, remoteStatus: 'cancelled' });
      remoteByRef.delete(reference);
    } else {
      matched.push(appointment);
      remoteByRef.delete(reference);
    }
  }

  return { matched, missingRemotely, statusMismatch, onlyRemotely: [...remoteByRef.values()] };
}
