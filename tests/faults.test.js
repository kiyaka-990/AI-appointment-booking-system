import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('faults');
const { agent, appointments, config, crm, db, faults, nextSlot } = ctx;
const ai = await import('../src/lib/ai.js');

const checkup = config.findService('checkup');

function customer(fullName, email, phone) {
  return crm.upsertCustomer({ fullName, email, phone, source: 'test' }).customer;
}

test.beforeEach(() => faults.resetFaults());
test.after(() => faults.resetFaults());

test('a calendar outage is reported and nothing is booked', async () => {
  const { slot } = nextSlot('checkup');
  faults.setFault('calendar.read', true);

  const result = await ctx.bookThroughChat({
    fullName: 'Nadia Khan',
    email: 'nadia@example.com',
    phone: '07700903001',
    serviceId: 'checkup',
    startMs: slot.startMs
  });

  assert.equal(result.error.code, 'CALENDAR_UNAVAILABLE');
  assert.equal(result.error.retryable, true);
  assert.equal(result.appointment, null);
  assert.match(result.reply, /nothing has been confirmed/i);
  assert.equal(
    db.all('SELECT id FROM appointments WHERE start_ms = ?', slot.startMs).length,
    0
  );
});

test('a CRM failure stops the booking before it is written', async () => {
  const { slot } = nextSlot('checkup');
  faults.setFault('crm', true);

  const result = await ctx.bookThroughChat({
    fullName: 'Omar Haddad',
    email: 'omar@example.com',
    phone: '07700903002',
    serviceId: 'checkup',
    startMs: slot.startMs
  });

  assert.equal(result.error.code, 'CRM_UNAVAILABLE');
  assert.equal(result.appointment, null);
  assert.equal(
    db.all('SELECT id FROM appointments WHERE start_ms = ?', slot.startMs).length,
    0
  );
});

test('a failed calendar write rolls the appointment back', () => {
  const { slot } = nextSlot('checkup');
  const person = customer('Ruth Bader', 'ruth@example.com', '07700903003');
  const before = db.all('SELECT id FROM appointments').length;
  faults.setFault('calendar.write', true);

  assert.throws(
    () => appointments.createAppointment({ customer: person, service: checkup, startMs: slot.startMs, actor: 'test' }),
    (error) => error.code === 'CALENDAR_UNAVAILABLE'
  );
  assert.equal(db.all('SELECT id FROM appointments').length, before);
  assert.equal(db.all('SELECT id FROM outbox').length >= 0, true);
  assert.equal(
    db.all("SELECT id FROM outbox WHERE template = 'confirmation' AND appointment_id NOT IN (SELECT id FROM appointments)").length,
    0
  );
});

test('a notification failure keeps the booking and retries the message', async () => {
  const { slot } = nextSlot('checkup');
  faults.setFault('notifications', true);

  const result = await ctx.bookThroughChat({
    fullName: 'Ivy Chen',
    email: 'ivy@example.com',
    phone: '07700903004',
    serviceId: 'checkup',
    startMs: slot.startMs
  });

  assert.ok(result.appointment, 'booking still confirmed');
  const stored = appointments.getAppointmentByReference(result.appointment.reference);
  assert.equal(stored.status, 'confirmed');

  const confirmation = db.get(
    "SELECT * FROM outbox WHERE appointment_id = ? AND template = 'confirmation'",
    stored.id
  );
  assert.equal(confirmation.status, 'pending');
  assert.equal(Number(confirmation.attempts), 1);
  assert.ok(confirmation.last_error, 'failure recorded for the retry worker');

  faults.resetFaults();
  const retry = await ctx.notifications.attemptDelivery(confirmation.id);
  assert.equal(retry.ok, true);
  assert.equal(db.get('SELECT status FROM outbox WHERE id = ?', confirmation.id).status, 'sent');
});

test('the AI switch falls back to the deterministic assistant', async () => {
  assert.equal(ai.aiStatus().enabled, false, 'no API key configured in tests');
  faults.setFault('ai', true);
  assert.equal(ai.aiConfig().enabled, false);
  assert.equal(ai.aiStatus().mode, 'deterministic-fallback');
});

test('a message is delivered exactly once even when two workers race', async () => {
  const { slot } = nextSlot('checkup');
  const person = customer('Rosalind Franklin', 'rosalind@example.com', '07700903005');
  const booking = appointments.createAppointment({
    customer: person,
    service: checkup,
    startMs: slot.startMs,
    actor: 'test'
  });
  const reminder = db.get(
    "SELECT * FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder-%'",
    booking.appointment.id
  );
  assert.ok(reminder, 'a reminder is queued');
  assert.equal(reminder.status, 'pending');

  // Two worker ticks overlapping (cron + a manual "process due queue" click).
  const [a, b] = await Promise.all([
    ctx.notifications.attemptDelivery(reminder.id),
    ctx.notifications.attemptDelivery(reminder.id)
  ]);
  const delivered = [a, b].filter((result) => result.ok && !result.skipped);
  assert.equal(delivered.length, 1, 'only the worker that claimed the row sends it');

  const after = db.get('SELECT * FROM outbox WHERE id = ?', reminder.id);
  assert.equal(after.status, 'sent');
  assert.equal(Number(after.attempts), 1, 'no double delivery');
});
