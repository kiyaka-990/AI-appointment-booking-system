import { get, nowIso, run } from './db.js';

/**
 * Inbound webhook de-duplication.
 *
 * Providers retry webhooks when the first delivery does not return a 2xx fast
 * enough. Twilio, for example, retries a WhatsApp webhook for up to three days
 * when it sees a timeout, and each retry would otherwise re-run the whole
 * assistant: a second reply, a second CRM write, a second booking attempt.
 *
 * Every inbound event is claimed here (unique on provider + event id) before the
 * workflow runs. The first request processes the event and stores its reply; a
 * retry of the same event id replays the stored reply instead of processing
 * again. A claim that went stale (the process died mid-handler) may be taken
 * over by a later retry so a crashed attempt is not lost forever.
 */

const STALE_MS = 90_000; // a fresh claim is trusted for this long before takeover
const RETAIN_DAYS = 7; // replay window; providers stop retrying long before this

/**
 * Claim one inbound event.
 *
 * Returns `{ duplicate: false, record }` when the caller must process the event
 * (it now owns the claim and must call `completeWebhookEvent` or
 * `failWebhookEvent`), or `{ duplicate: true, record, replay }` when the event
 * was already handled: `replay` is the stored reply text to send back verbatim.
 */
export function claimWebhookEvent({ provider, eventId, staleMs = STALE_MS } = {}) {
  // No id to dedupe on (should not happen with Twilio): process once and let
  // the caller behave exactly as before.
  if (!eventId) return { duplicate: false, record: null };

  const timestamp = nowIso();
  const inserted = run(
    `INSERT OR IGNORE INTO webhook_events (provider, event_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'processing', 1, ?, ?)`,
    String(provider ?? 'unknown'),
    String(eventId),
    timestamp,
    timestamp
  );

  const record = get(
    'SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?',
    String(provider ?? 'unknown'),
    String(eventId)
  );

  if (inserted.changes > 0) {
    maybePrune();
    return { duplicate: false, record };
  }

  const age = Date.now() - Date.parse(record.updated_at);
  if (record.status === 'done') {
    return { duplicate: true, record, replay: record.response_text ?? '' };
  }
  if (record.status === 'processing' && age < staleMs) {
    // Another request is mid-flight on this event: acknowledge it without
    // side effects. If that request finishes, its reply is already delivered
    // to the customer; this retry simply reports success to the provider.
    return { duplicate: true, record, replay: null };
  }

  // 'error' from a failed attempt, or a stale 'processing' claim from a dead
  // one: take the claim over and process again.
  run(
    "UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?",
    nowIso(),
    record.id
  );
  return { duplicate: false, record: { ...record, status: 'processing' } };
}

/** Store the successful reply so provider retries can replay it. */
export function completeWebhookEvent(record, responseText) {
  if (!record?.id) return;
  run(
    "UPDATE webhook_events SET status = 'done', response_text = ?, updated_at = ? WHERE id = ?",
    String(responseText ?? ''),
    nowIso(),
    record.id
  );
}

/** Release a claim after a failure so the next provider retry can process it. */
export function failWebhookEvent(record) {
  if (!record?.id) return;
  run("UPDATE webhook_events SET status = 'error', updated_at = ? WHERE id = ?", nowIso(), record.id);
}

/** Drop replay rows older than the retain window. */
export function pruneWebhookEvents({ retainDays = RETAIN_DAYS } = {}) {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString();
  run('DELETE FROM webhook_events WHERE updated_at < ?', cutoff);
}

// Housekeeping piggybacks on traffic (every ~25th claim) instead of needing a
// cron entry; an error here must never fail the webhook itself.
let pruneCount = 0;
function maybePrune() {
  pruneCount += 1;
  if (pruneCount % 25 !== 1) return;
  try {
    pruneWebhookEvents();
  } catch {
    // Non-fatal.
  }
}
