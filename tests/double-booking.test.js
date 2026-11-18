import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('double');
const { appointments, config, crm, db, nextSlot } = ctx;

const checkup = config.findService('checkup');
const hygiene = config.findService('hygiene');

function customer(fullName, email, phone) {
  return crm.upsertCustomer({ fullName, email, phone, source: 'test' }).customer;
}

test('two customers cannot hold the same slot', () => {
  const { slot } = nextSlot('checkup');
  const ada = customer('Ada Lovelace', 'ada@example.com', '07700901001');
  const grace = customer('Grace Hopper', 'grace@example.com', '07700901002');

  const first = appointments.createAppointment({ customer: ada, service: checkup, startMs: slot.startMs, actor: 'test' });
  assert.ok(first.created);

  assert.throws(
    () => appointments.createAppointment({ customer: grace, service: checkup, startMs: slot.startMs, actor: 'test' }),
    (error) => error.code === 'SLOT_TAKEN'
  );

  const rows = db.all(
    "SELECT reference, customer_id FROM appointments WHERE start_ms = ? AND status = 'confirmed'",
    slot.startMs
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer_id, ada.id);
});

test('a simultaneous double submit creates exactly one appointment', async () => {
  const { slot } = nextSlot('hygiene');
  const one = customer('Alan Turing', 'alan@example.com', '07700901003');
  const two = customer('Katherine Johnson', 'katherine@example.com', '07700901004');

  // The API layer is what runs concurrently in production, so make each attempt
  // an independent async task that resolves to a booking or rejects.
  const attempt = (person) =>
    Promise.resolve().then(() =>
      appointments.createAppointment({ customer: person, service: hygiene, startMs: slot.startMs, actor: 'test' })
    );
  const outcomes = await Promise.allSettled([attempt(one), attempt(two)]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(db.all('SELECT id FROM appointments WHERE start_ms = ?', slot.startMs).length, 1);
});

test('the same customer cannot book the same window twice', () => {
  const { slot } = nextSlot('checkup');
  const person = customer('Nina Simone', 'nina@example.com', '07700901005');

  appointments.createAppointment({ customer: person, service: checkup, startMs: slot.startMs, actor: 'test' });
  assert.throws(
    () =>
      appointments.createAppointment({
        customer: person,
        service: checkup,
        startMs: slot.startMs,
        actor: 'test'
      }),
    (error) => error.code === 'DUPLICATE_BOOKING'
  );
});

test('an idempotency key replays the original booking instead of duplicating it', () => {
  const { slot } = nextSlot('hygiene');
  const person = customer('Ida B Wells', 'ida@example.com', '07700901006');
  const key = 'enquiry-1234';

  const first = appointments.createAppointment({
    customer: person,
    service: hygiene,
    startMs: slot.startMs,
    idempotencyKey: key,
    actor: 'test'
  });
  const replay = appointments.createAppointment({
    customer: person,
    service: hygiene,
    startMs: slot.startMs,
    idempotencyKey: key,
    actor: 'test'
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.appointment.reference, first.appointment.reference);
  assert.equal(db.all('SELECT id FROM appointments WHERE customer_id = ?', person.id).length, 1);
});

test('cancelling a booking releases the slot for someone else', async () => {
  const { slot } = nextSlot('checkup');
  const first = customer('Maya Angelou', 'maya@example.com', '07700901007');
  const second = customer('Toni Morrison', 'toni@example.com', '07700901008');

  const booking = appointments.createAppointment({
    customer: first,
    service: checkup,
    startMs: slot.startMs,
    actor: 'test'
  });
  await appointments.cancelAppointment({ reference: booking.appointment.reference, actor: 'test' });

  const rebooked = appointments.createAppointment({
    customer: second,
    service: checkup,
    startMs: slot.startMs,
    actor: 'test'
  });
  assert.equal(rebooked.appointment.startMs, slot.startMs);
});
