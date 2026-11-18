import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('cancel');
const { agent, appointments, config, crm, db, nextSlot, time } = ctx;

const checkup = config.findService('checkup');
const DAY_MS = time.DAY_MS;

function customer(fullName, email, phone) {
  return crm.upsertCustomer({ fullName, email, phone, source: 'test' }).customer;
}

function bookingFor(person) {
  const { slot } = nextSlot('checkup');
  return appointments.createAppointment({ customer: person, service: checkup, startMs: slot.startMs, actor: 'test' })
    .appointment;
}

test('cancelling frees the calendar, stops reminders and notifies the customer', async () => {
  const person = customer('Jane Doe', 'jane.cancel@example.com', '07700902001');
  const appointment = bookingFor(person);

  const result = await appointments.cancelAppointment({
    reference: appointment.reference,
    reason: 'Away that week',
    actor: 'test'
  });

  assert.equal(result.appointment.status, 'cancelled');
  assert.equal(result.appointment.cancellationReason, 'Away that week');

  const reminders = db.all(
    "SELECT status FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder-%'",
    appointment.id
  );
  assert.ok(reminders.length > 0);
  assert.ok(reminders.every((row) => row.status === 'cancelled'));

  const notice = db.get(
    "SELECT status, recipient FROM outbox WHERE appointment_id = ? AND template = 'cancellation'",
    appointment.id
  );
  assert.equal(notice.status, 'sent');
  assert.equal(notice.recipient, 'jane.cancel@example.com');

  const check = ctx.availability.checkSlot({
    startMs: appointment.startMs,
    service: checkup,
    timeZone: ctx.tz
  });
  assert.equal(check.available, true);
});

test('unknown and already-cancelled references are reported precisely', async () => {
  await assert.rejects(
    () => appointments.cancelAppointment({ reference: 'BS-2026-ZZZZZ', actor: 'test' }),
    (error) => error.code === 'BOOKING_NOT_FOUND'
  );

  const person = customer('Robin Hale', 'robin@example.com', '07700902002');
  const appointment = bookingFor(person);
  await appointments.cancelAppointment({ reference: appointment.reference, actor: 'test' });

  await assert.rejects(
    () => appointments.cancelAppointment({ reference: appointment.reference, actor: 'test' }),
    (error) => error.code === 'BOOKING_ALREADY_CANCELLED'
  );
});

test('rescheduling keeps the reference, moves the time and re-arms reminders', async () => {
  const person = customer('Sam Reed', 'sam@example.com', '07700902003');
  const appointment = bookingFor(person);
  const { slot: later } = nextSlot('checkup', appointment.startMs + 2 * DAY_MS);

  const result = await appointments.rescheduleAppointment({
    reference: appointment.reference,
    startMs: later.startMs,
    actor: 'test'
  });

  assert.equal(result.appointment.reference, appointment.reference);
  assert.equal(result.appointment.startMs, later.startMs);
  assert.equal(result.appointment.rescheduledFrom, new Date(appointment.startMs).toISOString());

  const pending = db.all(
    "SELECT template FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder-%' AND status = 'pending'",
    appointment.id
  );
  assert.equal(pending.length, 2);
  const superseded = db.all(
    "SELECT id FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder-%' AND status = 'cancelled'",
    appointment.id
  );
  assert.ok(superseded.length >= 1);
});

test('rescheduling into an occupied slot changes nothing', async () => {
  const first = customer('Kim Lee', 'kim@example.com', '07700902004');
  const second = customer('Jo Blake', 'jo@example.com', '07700902005');
  const { slot: target } = nextSlot('checkup');
  appointments.createAppointment({ customer: second, service: checkup, startMs: target.startMs, actor: 'test' });
  const appointment = bookingFor(first);

  await assert.rejects(
    () =>
      appointments.rescheduleAppointment({
        reference: appointment.reference,
        startMs: target.startMs,
        actor: 'test'
      }),
    (error) => ['SLOT_TAKEN', 'DUPLICATE_BOOKING'].includes(error.code)
  );

  const after = appointments.getAppointmentByReference(appointment.reference);
  assert.equal(after.startMs, appointment.startMs);
  assert.equal(after.status, 'confirmed');
});

test('cancelling through chat verifies the caller before touching the booking', async () => {
  const person = customer('Priya Shah', 'priya@example.com', '07700902006');
  const appointment = bookingFor(person);

  const result = await agent.handleMessage({
    message: `Please cancel ${appointment.reference}.`,
    channel: 'test',
    contact: { fullName: 'Someone Else', email: 'stranger@example.com', phone: '07700902999' }
  });

  assert.equal(result.error.code, 'CONTACT_MISMATCH');
  assert.equal(result.stage, 'cancel_identify');
  assert.equal(appointments.getAppointmentByReference(appointment.reference).status, 'confirmed');
});

test('a customer can reschedule their own booking through chat', async () => {
  const person = customer('Leo Grant', 'leo@example.com', '07700902007');
  const appointment = bookingFor(person);
  const { slot: later } = nextSlot('checkup', appointment.startMs + 2 * DAY_MS);
  const when = `${time.formatDate(later.startMs, ctx.tz)} at ${time.formatTime(later.startMs, ctx.tz)}`;

  const identified = await agent.handleMessage({
    message: `I need to reschedule ${appointment.reference}.`,
    channel: 'test',
    contact: { fullName: 'Leo Grant', email: 'leo@example.com', phone: '07700902007' }
  });
  assert.equal(identified.stage, 'reschedule_collect_time');

  const moved = await agent.handleMessage({
    conversationId: identified.conversationId,
    message: when
  });

  assert.equal(moved.actions.includes('booking_rescheduled'), true);
  assert.equal(appointments.getAppointmentByReference(appointment.reference).startMs, later.startMs);
});
