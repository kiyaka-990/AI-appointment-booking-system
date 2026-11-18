import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('events');
const events = await import('../src/lib/events.js');
const { agent, appointments, nextSlot, whenText } = ctx;

test('booking publishes a confirmed event to the chat stream only', async () => {
  const first = await agent.handleMessage({ message: 'Hello' });
  const conversationId = first.conversationId;
  assert.ok(conversationId, 'conversation id returned');

  const mine = [];
  const other = [];
  const unsubscribeMine = events.subscribe(conversationId, (event) => mine.push(event));
  const unsubscribeOther = events.subscribe('cnv_someone_else', (event) => other.push(event));

  const { slot } = nextSlot('checkup');
  const booked = await agent.handleMessage({
    conversationId,
    message: `I am Event Tester, event.tester@example.com, 07700900444. I want a check-up on ${whenText(slot.startMs)}`
  });

  unsubscribeMine();
  unsubscribeOther();

  assert.equal(booked.stage, 'booked');
  assert.equal(mine.length, 1, 'one event for this conversation');
  assert.equal(mine[0].type, 'appointment');
  assert.equal(mine[0].status, 'confirmed');
  assert.equal(mine[0].reference, booked.appointment.reference);
  assert.equal(other.length, 0, 'other conversations receive nothing');
  assert.equal(events.listenerCount(conversationId), 0, 'listeners are released');
});

test('cancelling publishes a cancelled event with no personal details', async () => {
  const first = await agent.handleMessage({ message: 'Hi there' });
  const conversationId = first.conversationId;
  // A later window: the first test already took the earliest slot.
  const { slot } = nextSlot('hygiene', Date.now() + 9 * ctx.time.DAY_MS);
  const booked = await agent.handleMessage({
    conversationId,
    message: `I am Nadia Okoye, nadia.okoye@example.com, 07700900555. I want hygiene on ${whenText(slot.startMs)}`
  });

  assert.ok(booked.appointment, JSON.stringify({ stage: booked.stage, reply: booked.reply, error: booked.error }));

  const received = [];
  const unsubscribe = events.subscribe(conversationId, (event) => received.push(event));
  await appointments.cancelAppointment({
    reference: booked.appointment.reference,
    reason: 'test',
    actor: 'test'
  });
  unsubscribe();

  assert.equal(received.at(-1).status, 'cancelled');
  assert.equal(received.at(-1).reference, booked.appointment.reference);
  assert.deepEqual(Object.keys(received.at(-1)).sort(), ['reference', 'serviceName', 'startMs', 'status', 'type']);
  assert.equal(JSON.stringify(received).includes('example.com'), false, 'no email in stream payload');
});
