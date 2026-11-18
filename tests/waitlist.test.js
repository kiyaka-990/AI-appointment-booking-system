import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('waitlist');
const waitlist = await import('../src/lib/waitlist.js');
const { agent, appointments, config, db, nextSlot, whenText, time } = ctx;

test('a customer with no suitable time joins the waiting list', async () => {
  const first = await agent.handleMessage({ message: 'Nothing works this week, put me on the waiting list for hygiene please.' });
  assert.equal(first.intent, 'waitlist');
  assert.equal(first.stage, 'waitlist_collect');
  assert.match(first.reply, /full name/i);

  const second = await agent.handleMessage({
    conversationId: first.conversationId,
    message: 'I am Nadia Hale, nadia.hale@example.com, 07700900123'
  });
  assert.equal(second.stage, 'waitlisted');
  assert.match(second.reply, /waiting list for Hygiene & Polish/i);

  const entry = db.get("SELECT * FROM waitlist WHERE email = 'nadia.hale@example.com'");
  assert.ok(entry, 'waitlist row created');
  assert.equal(entry.status, 'waiting');
  assert.equal(entry.service_id, 'hygiene');
  assert.equal(entry.full_name, 'Nadia Hale');

  const confirmation = db.get(
    "SELECT * FROM outbox WHERE template = 'waitlist-joined' AND recipient = 'nadia.hale@example.com'"
  );
  assert.ok(confirmation, 'join confirmation queued');
  assert.equal(confirmation.status, 'sent');
});

test('cancelling a booking offers the freed slot to the waiting customer', async () => {
  const { slot } = nextSlot('hygiene', Date.now() + 5 * time.DAY_MS);
  const booked = await agent.handleMessage({
    message: `I am Owen Field, owen.field@example.com, 07700900456. I want hygiene on ${whenText(slot.startMs)}`
  });
  assert.ok(booked.appointment, 'booking exists to cancel');

  await appointments.cancelAppointment({ reference: booked.appointment.reference, actor: 'test' });

  const entry = db.get("SELECT * FROM waitlist WHERE email = 'nadia.hale@example.com'");
  assert.equal(entry.status, 'notified');
  assert.ok(entry.notified_at);

  const offer = db.get(
    "SELECT * FROM outbox WHERE template = 'waitlist-available' AND recipient = 'nadia.hale@example.com'"
  );
  assert.ok(offer, 'slot offer queued');
  assert.equal(offer.status, 'sent');
  assert.match(offer.subject, /slot has opened/i);
});

test('only matching waitlist entries are offered the slot', async () => {
  const checkup = config.findService('checkup');
  waitlist.addWaitlist({
    fullName: 'Mismatch Customer',
    email: 'mismatch@example.com',
    phone: '07700900789',
    service: checkup
  });
  const future = waitlist.addWaitlist({
    fullName: 'Future Customer',
    email: 'future@example.com',
    phone: '07700900790',
    service: config.findService('hygiene'),
    fromMs: Date.now() + 40 * time.DAY_MS,
    toMs: Date.now() + 60 * time.DAY_MS
  });

  const { slot } = nextSlot('hygiene', Date.now() + 8 * time.DAY_MS);
  const booked = await agent.handleMessage({
    message: `I am Ivy Lane, ivy.lane@example.com, 07700900567. I want hygiene on ${whenText(slot.startMs)}`
  });
  await appointments.cancelAppointment({ reference: booked.appointment.reference, actor: 'test' });

  const mismatch = db.get("SELECT * FROM waitlist WHERE email = 'mismatch@example.com'");
  const stillFuture = db.get('SELECT * FROM waitlist WHERE id = ?', future.id);
  assert.equal(mismatch.status, 'waiting', 'a check-up waiting list is not offered a hygiene slot');
  assert.equal(stillFuture.status, 'waiting', 'a window in 40 days is not offered an earlier slot');

  const offers = db.all(
    "SELECT recipient FROM outbox WHERE template = 'waitlist-available' ORDER BY id"
  );
  assert.equal(offers.some((row) => row.recipient === 'mismatch@example.com'), false);
  assert.equal(offers.some((row) => row.recipient === 'future@example.com'), false);
});

test('staff can list and remove waiting customers', async () => {
  const waiting = waitlist.listWaitlist({ status: 'waiting' });
  assert.ok(waiting.length >= 2);
  const target = waiting[0];
  const left = waitlist.leaveWaitlist(target.id);
  assert.equal(left.status, 'cancelled');
});
