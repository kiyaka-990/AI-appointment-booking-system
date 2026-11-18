import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('staff-notifications');
const events = await import('../src/lib/events.js');
const { appointments, nextSlot, time } = ctx;

test('the staff stream receives created, moved and cancelled bookings', async () => {
  const received = [];
  const unsubscribe = events.subscribe(events.STAFF_CHANNEL, (event) => received.push(event));

  const customer = ctx.makeCustomer('Priya Shah', 'priya.shah@example.com', '07700900111');
  const { service, slot } = nextSlot('checkup', Date.now() + 4 * time.DAY_MS);
  const created = appointments.createAppointment({
    customer,
    service,
    startMs: slot.startMs,
    source: 'test',
    actor: 'test'
  });

  assert.equal(created.created, true);
  assert.equal(received.at(-1).type, 'booking');
  assert.equal(received.at(-1).action, 'created');
  assert.equal(received.at(-1).customerName, 'Priya Shah');
  assert.equal(received.at(-1).reference, created.appointment.reference);

  const { slot: moved } = nextSlot('checkup', Date.now() + 6 * time.DAY_MS);
  await appointments.rescheduleAppointment({
    reference: created.appointment.reference,
    startMs: moved.startMs,
    actor: 'test'
  });
  assert.equal(received.at(-1).action, 'rescheduled');
  assert.equal(received.at(-1).previousStartMs, created.appointment.startMs);
  assert.equal(received.at(-1).startMs, moved.startMs);

  await appointments.cancelAppointment({
    reference: created.appointment.reference,
    reason: 'test',
    actor: 'test'
  });
  assert.equal(received.at(-1).action, 'cancelled');
  assert.equal(received.at(-1).customerName, 'Priya Shah');

  unsubscribe();
  assert.equal(events.listenerCount(events.STAFF_CHANNEL), 0, 'listeners are released');
});

test('an owner phone with a configured provider queues one short alert', async () => {
  process.env.OWNER_PHONE = '+447700900999';
  process.env.OWNER_ALERT_CHANNEL = 'sms';
  process.env.NOTIFICATIONS_MODE = 'twilio';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_FROM = '+441234567890';
  try {
    const customer = ctx.makeCustomer('Marco Bianchi', 'marco.bianchi@example.com', '07700900222');
    const { service, slot } = nextSlot('hygiene', Date.now() + 9 * time.DAY_MS);
    const booking = appointments.createAppointment({
      customer,
      service,
      startMs: slot.startMs,
      source: 'web-chat',
      idempotencyKey: 'owner-alert-dedupe',
      actor: 'test'
    });

    const rows = ctx.db.all(
      "SELECT * FROM outbox WHERE appointment_id = ? AND template = 'owner-alert'",
      booking.appointment.id
    );
    assert.equal(rows.length, 1, 'exactly one owner alert');
    assert.equal(rows[0].channel, 'sms');
    assert.equal(rows[0].recipient, '+447700900999');
    assert.equal(rows[0].status, 'pending');
    assert.match(rows[0].body, /New booking:/);
    assert.match(rows[0].body, new RegExp(booking.appointment.reference));

    const replay = appointments.createAppointment({
      customer,
      service,
      startMs: slot.startMs,
      source: 'web-chat',
      idempotencyKey: 'owner-alert-dedupe',
      actor: 'test'
    });
    assert.equal(replay.replayed, true);
    const afterReplay = ctx.db.all(
      "SELECT id FROM outbox WHERE appointment_id = ? AND template = 'owner-alert'",
      booking.appointment.id
    );
    assert.equal(afterReplay.length, 1, 'a provider retry cannot queue a second alert');
  } finally {
    for (const key of [
      'OWNER_PHONE',
      'OWNER_ALERT_CHANNEL',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM'
    ]) {
      delete process.env[key];
    }
    process.env.NOTIFICATIONS_MODE = 'console';
  }
});

test('no owner phone means no SMS alert is queued', () => {
  const customer = ctx.makeCustomer('Lena Fischer', 'lena.fischer@example.com', '07700900333');
  const { service, slot } = nextSlot('checkup', Date.now() + 12 * time.DAY_MS);
  const booking = appointments.createAppointment({
    customer,
    service,
    startMs: slot.startMs,
    source: 'test',
    actor: 'test'
  });
  const rows = ctx.db.all(
    "SELECT id FROM outbox WHERE appointment_id = ? AND template = 'owner-alert'",
    booking.appointment.id
  );
  assert.equal(rows.length, 0);
});
