import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('booking');
const { agent, appointments, config, crm, db, nextSlot, whenText } = ctx;

const checkup = config.findService('checkup');
const hygiene = config.findService('hygiene');

test('asks for the missing details instead of guessing them', async () => {
  const result = await agent.handleMessage({ message: 'I would like an appointment please.' });
  assert.equal(result.error.code, 'MISSING_INFORMATION');
  assert.equal(result.intent, 'book');
  assert.match(result.reply, /name/i);
  assert.equal(result.appointment, null);
});

test('books an available slot, confirms it and queues both reminders', async () => {
  const { slot } = nextSlot('checkup');
  const result = await ctx.bookThroughChat({
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: '07700900123',
    serviceId: 'checkup',
    startMs: slot.startMs
  });

  assert.equal(result.stage, 'booked');
  assert.ok(result.appointment, 'appointment returned');
  assert.match(result.appointment.reference, /^BS-\d{4}-[A-Z0-9]{5}$/);
  assert.match(result.reply, /Reference:/);

  const stored = appointments.getAppointmentByReference(result.appointment.reference);
  assert.equal(stored.status, 'confirmed');
  assert.equal(stored.startMs, slot.startMs);

  const rows = db.all(
    'SELECT template, status, recipient FROM outbox WHERE appointment_id = ? ORDER BY template',
    stored.id
  );
  const confirmation = rows.find((row) => row.template === 'confirmation');
  assert.equal(confirmation.status, 'sent');
  assert.equal(confirmation.recipient, 'jane@example.com');

  const reminders = rows.filter((row) => row.template.startsWith('reminder-'));
  assert.deepEqual(
    reminders.map((row) => row.template).sort(),
    ['reminder-1h', 'reminder-24h']
  );
  assert.ok(reminders.every((row) => row.status === 'pending'));

  // The business owner is told about every new booking.
  const ownerNotice = rows.find((row) => row.template === 'owner-booking');
  assert.ok(ownerNotice, 'owner notification queued');
  assert.equal(ownerNotice.status, 'sent');
  assert.equal(ownerNotice.recipient, config.business().supportEmail);

  const customer = crm.getCustomer(stored.customerId);
  assert.equal(customer.full_name, 'Jane Doe');
  assert.equal(customer.email, 'jane@example.com');
  assert.equal(customer.phone, '07700900123');
});

test('offers alternatives when the requested slot is already booked', async () => {
  const { slot } = nextSlot('hygiene');
  const { customer } = crm.upsertCustomer({
    fullName: 'Marcus Webb',
    email: 'marcus@example.com',
    phone: '07700900456'
  });
  appointments.createAppointment({ customer, service: hygiene, startMs: slot.startMs, actor: 'test' });

  const result = await ctx.bookThroughChat({
    fullName: 'Elena Petrova',
    email: 'elena@example.com',
    phone: '07700900512',
    serviceId: 'hygiene',
    startMs: slot.startMs
  });

  assert.match(result.reply, /not available/i);
  assert.ok((result.reply.match(/^- /gm) ?? []).length >= 2, 'at least two alternatives listed');
  assert.equal(result.appointment, null);
  assert.equal(result.stage, 'awaiting_confirmation');
  assert.equal(db.all('SELECT id FROM appointments WHERE start_ms = ?', slot.startMs).length, 1);
});

test('explains a closed day and offers the next openings', async () => {
  const { slot } = nextSlot('checkup');
  // Sunday is closed in config/business.json.
  const sunday = new Date(slot.startMs);
  while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() + 1);
  const result = await ctx.bookThroughChat({
    fullName: 'Owen Fry',
    email: 'owen@example.com',
    phone: '07700900634',
    serviceId: 'checkup',
    startMs: sunday.getTime()
  });

  assert.equal(result.appointment, null);
  assert.match(result.reply, /not available|closed/i);
  assert.ok((result.reply.match(/^- /gm) ?? []).length >= 1);
});

test('rejects a service the business does not offer', async () => {
  const result = await agent.handleMessage({
    message: 'Hi, I am Ravi Patel, ravi@example.com, 07700900700. I need a haircut on Tuesday at 10am.'
  });
  assert.equal(result.appointment, null);
  assert.match(result.reply, /which service/i);
});

test('never double books a customer who already holds that time', async () => {
  const { slot } = nextSlot('checkup');
  const first = await ctx.bookThroughChat({
    fullName: 'Dana Cole',
    email: 'dana@example.com',
    phone: '07700900811',
    serviceId: 'checkup',
    startMs: slot.startMs
  });
  assert.ok(first.appointment);

  const again = await agent.handleMessage({
    conversationId: first.conversationId,
    message: `Can I book a check-up on ${whenText(slot.startMs)}?`
  });

  assert.equal(again.error.code, 'DUPLICATE_BOOKING');
  assert.match(again.reply, /already have/i);
  assert.ok(again.reply.includes(first.appointment.reference));
});

test('an availability question is not turned into a booking by a model mistake', async () => {
  const { resolveIntent } = ctx.agent;
  const llm = { intent: 'book', collected: {}, source: 'llm' };
  const fallback = { intent: 'availability', collected: {} };

  assert.equal(resolveIntent(llm, fallback, {}).intent, 'availability');
  assert.equal(resolveIntent(llm, fallback, { preferredStartMs: 1794915900000 }).intent, 'book');
  assert.equal(resolveIntent({ intent: 'book' }, { intent: 'book' }, {}).intent, 'book');
  assert.equal(resolveIntent(null, fallback, {}).intent, 'availability');
});

test('an availability question lists real openings with tappable times', async () => {
  const result = await agent.handleMessage({ message: 'What times are free this week?' });

  assert.equal(result.intent, 'availability');
  assert.equal(result.appointment, null);
  assert.match(result.reply, /next openings|Which service/i);
  assert.ok(result.suggestions.length > 0, 'times offered as suggestions');
  assert.ok(result.suggestions.every((item) => item.send && item.label));

  const hygiene = await agent.handleMessage({ message: 'What times are free for a hygiene appointment?' });
  assert.equal(hygiene.intent, 'availability');
  assert.match(hygiene.reply, /Hygiene/);
  assert.ok(hygiene.suggestions.length > 0);
});
