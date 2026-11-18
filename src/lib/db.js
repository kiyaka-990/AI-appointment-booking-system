import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let database = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  source        TEXT,
  notes         TEXT,
  tags          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_email ON customers(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_phone ON customers(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT REFERENCES customers(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL,
  external_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  state           TEXT NOT NULL DEFAULT '{}',
  summary         TEXT,
  structured      TEXT,
  last_intent     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conversations_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS ix_conversations_external ON conversations(channel, external_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  meta            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS appointments (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,
  customer_id         TEXT NOT NULL REFERENCES customers(id),
  conversation_id     TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  service_id          TEXT NOT NULL,
  service_name        TEXT NOT NULL,
  start_ms            INTEGER NOT NULL,
  end_ms              INTEGER NOT NULL,
  start_local         TEXT NOT NULL,
  end_local           TEXT NOT NULL,
  status              TEXT NOT NULL,
  location            TEXT,
  notes               TEXT,
  source              TEXT,
  idempotency_key     TEXT,
  rescheduled_from    TEXT,
  rescheduled_to      TEXT,
  cancellation_reason TEXT,
  cancelled_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_start_active
  ON appointments(start_ms) WHERE status IN ('confirmed', 'pending');
CREATE INDEX IF NOT EXISTS ix_appointments_customer ON appointments(customer_id);
CREATE INDEX IF NOT EXISTS ix_appointments_window ON appointments(start_ms, end_ms);
CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_idempotency
  ON appointments(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointment_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  actor          TEXT,
  payload        TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_appointment ON appointment_events(appointment_id, id);

CREATE TABLE IF NOT EXISTS outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE CASCADE,
  customer_id    TEXT REFERENCES customers(id) ON DELETE SET NULL,
  channel        TEXT NOT NULL,
  recipient      TEXT,
  template       TEXT NOT NULL,
  subject        TEXT,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  scheduled_for  TEXT NOT NULL,
  dedupe_key     TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  sent_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_dedupe ON outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_outbox_due ON outbox(status, scheduled_for);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  window_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id);

-- Outbound integration events (the bridge to a client's existing system).
CREATE TABLE IF NOT EXISTS bridge_outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event          TEXT NOT NULL,
  appointment_id TEXT,
  payload        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_at        TEXT,
  last_error     TEXT,
  sent_at        TEXT,
  dedupe_key     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bridge_dedupe ON bridge_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bridge_due ON bridge_outbox(status, next_at);

-- Inbound webhook events (Twilio MessageSid, enquiry externalId...). A provider
-- retry of the same event id is replayed from here instead of being processed
-- again, so a retried webhook can never double-book or send a second reply.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'processing',
  response_text TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_events_event
  ON webhook_events(provider, event_id);
CREATE INDEX IF NOT EXISTS ix_webhook_events_updated ON webhook_events(updated_at);

-- Customers waiting for a cancellation to free a slot.
CREATE TABLE IF NOT EXISTS waitlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
  full_name     TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  service_id    TEXT,
  service_name  TEXT,
  from_ms       INTEGER,
  to_ms         INTEGER,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'waiting',
  notified_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_waitlist_match ON waitlist(status, service_id, from_ms, to_ms);
`;

export function databasePath() {
  return process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'booking.db');
}

export function openDatabase(file = databasePath()) {
  if (database) return database;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec(SCHEMA);
  return database;
}

export function db() {
  if (!database) return openDatabase();
  return database;
}

export function closeDatabase() {
  if (database) {
    database.close();
    database = null;
  }
}

/**
 * Serialised write transaction. BEGIN IMMEDIATE makes concurrent writers queue
 * at the database level, which is what stops two customers grabbing one slot.
 */
export function transaction(fn) {
  const handle = db();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // Transaction was already rolled back by SQLite.
    }
    throw error;
  }
}

export function all(sql, ...params) {
  return db().prepare(sql).all(...params);
}

export function get(sql, ...params) {
  return db().prepare(sql).get(...params);
}

export function run(sql, ...params) {
  return db().prepare(sql).run(...params);
}

export function nowIso() {
  return new Date().toISOString();
}

export function audit(action, { actor = 'system', entity = null, entityId = null, detail = null } = {}) {
  run(
    'INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    actor,
    action,
    entity,
    entityId,
    detail ? JSON.stringify(detail) : null,
    nowIso()
  );
}
