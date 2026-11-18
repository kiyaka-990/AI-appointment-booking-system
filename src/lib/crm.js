import { all, get, nowIso, run } from './db.js';
import { guard } from './faults.js';
import { randomUUID } from 'node:crypto';

export function normaliseEmail(value) {
  const trimmed = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) ? trimmed : null;
}

export function normalisePhone(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const digits = raw.replace(/[^\d+]/g, '');
  const count = digits.replace(/\D/g, '').length;
  if (count < 8 || count > 15) return null;
  if (raw.includes('/')) return null;
  return digits;
}

export function isValidName(value) {
  const name = String(value ?? '').trim();
  return name.length >= 2 && name.length <= 80 && /[a-zA-Z\p{L}]/u.test(name);
}

export function findCustomerByContact({ email, phone } = {}) {
  const cleanEmail = normaliseEmail(email);
  const cleanPhone = normalisePhone(phone);
  if (cleanEmail) {
    const row = get('SELECT * FROM customers WHERE lower(email) = ?', cleanEmail);
    if (row) return row;
  }
  if (cleanPhone) {
    const row = get('SELECT * FROM customers WHERE phone = ?', cleanPhone);
    if (row) return row;
  }
  return null;
}

export function getCustomer(id) {
  return get('SELECT * FROM customers WHERE id = ?', id) ?? null;
}

/**
 * Create or update the CRM record. Called before the appointment is written so
 * a CRM outage can never leave a confirmed booking with no customer attached.
 */
export function upsertCustomer({ fullName, email, phone, source = 'web-chat', notes = null, tags = null } = {}) {
  guard('crm');
  const cleanEmail = normaliseEmail(email);
  const cleanPhone = normalisePhone(phone);
  const name = String(fullName ?? '').trim();
  const existing = findCustomerByContact({ email: cleanEmail, phone: cleanPhone });
  const timestamp = nowIso();

  if (existing) {
    const nextName = isValidName(name) && name !== existing.full_name ? name : existing.full_name;
    run(
      `UPDATE customers
          SET full_name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone),
              notes = COALESCE(?, notes), tags = COALESCE(?, tags), updated_at = ?
        WHERE id = ?`,
      nextName,
      cleanEmail,
      cleanPhone,
      notes,
      tags,
      timestamp,
      existing.id
    );
    return { customer: getCustomer(existing.id), created: false };
  }

  if (!isValidName(name)) return { customer: null, created: false, reason: 'NAME_REQUIRED' };

  const id = `cus_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  run(
    `INSERT INTO customers (id, full_name, email, phone, source, notes, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    cleanEmail,
    cleanPhone,
    source,
    notes,
    tags,
    timestamp,
    timestamp
  );
  return { customer: getCustomer(id), created: true };
}

export function appendCustomerNote(customerId, note) {
  if (!customerId || !note) return;
  const customer = getCustomer(customerId);
  if (!customer) return;
  const composed = [customer.notes, `[${new Date().toISOString().slice(0, 10)}] ${note}`].filter(Boolean).join('\n');
  run('UPDATE customers SET notes = ?, updated_at = ? WHERE id = ?', composed, nowIso(), customerId);
}

export function setCustomerTags(customerId, tags) {
  run('UPDATE customers SET tags = ?, updated_at = ? WHERE id = ?', tags, nowIso(), customerId);
}

export function listCustomers({ limit = 100, search = null } = {}) {
  const like = search ? `%${search}%` : null;
  return all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id AND a.status IN ('confirmed','pending')) AS active_bookings,
            (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id) AS total_bookings
       FROM customers c
      WHERE (? IS NULL OR c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
      ORDER BY c.updated_at DESC
      LIMIT ?`,
    like,
    like,
    like,
    like,
    limit
  );
}

export function customerTimeline(customerId) {
  const customer = getCustomer(customerId);
  if (!customer) return null;
  return {
    customer,
    appointments: all(
      'SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_ms DESC',
      customerId
    ),
    conversations: all(
      'SELECT id, channel, status, summary, updated_at FROM conversations WHERE customer_id = ? ORDER BY updated_at DESC',
      customerId
    )
  };
}

/** Persist the AI's structured understanding of the conversation. */
export function saveConversationInsight(conversationId, { summary, structured }) {
  run(
    `UPDATE conversations
        SET summary = COALESCE(?, summary),
            structured = COALESCE(?, structured),
            updated_at = ?
      WHERE id = ?`,
    summary ?? null,
    structured ? JSON.stringify(structured) : null,
    nowIso(),
    conversationId
  );
}
