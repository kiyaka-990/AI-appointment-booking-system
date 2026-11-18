import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const ctx = await boot('bridge');
const bridge = await import('../src/lib/bridge.js');
const { agent, appointments, db, nextSlot, whenText } = ctx;

const ORIGINAL_FETCH = globalThis.fetch;

function stubFetch(handler = () => new Response('{}', { status: 200 })) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return calls;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

test('a booking is posted to the client system as an appointment.created event', async () => {
  process.env.BRIDGE_WEBHOOK_URL = 'https://client.example/hooks/appointments';
  process.env.BRIDGE_WEBHOOK_TOKEN = 'bridge-secret';
  const calls = stubFetch();

  const { slot } = nextSlot('checkup');
  const result = await agent.handleMessage({
    message: `I am Bridge Tester, bridge.tester@example.com, 07700900999. I want a check-up on ${whenText(slot.startMs)}`
  });
  assert.equal(result.stage, 'booked');
  await settle();

  assert.equal(calls.length, 1, 'one bridge delivery');
  assert.equal(calls[0].url, 'https://client.example/hooks/appointments');
  assert.equal(calls[0].options.headers.authorization, 'Bearer bridge-secret');
  assert.equal(calls[0].options.headers['x-bridge-event'], 'appointment.created');

  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.event, 'appointment.created');
  assert.equal(payload.appointment.reference, result.appointment.reference);
  assert.equal(payload.appointment.status, 'confirmed');
  assert.equal(payload.customer.email, 'bridge.tester@example.com');
  assert.match(payload.appointment.start, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(payload.business.timezone);

  const row = db.get('SELECT * FROM bridge_outbox ORDER BY id DESC LIMIT 1');
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1);

  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.BRIDGE_WEBHOOK_URL;
  delete process.env.BRIDGE_WEBHOOK_TOKEN;
  void appointments;
});

test('a cancellation is posted too, with the cancelled status', async () => {
  process.env.BRIDGE_WEBHOOK_URL = 'https://client.example/hooks/appointments';
  const calls = stubFetch();

  const { slot } = nextSlot('hygiene', Date.now() + 12 * ctx.time.DAY_MS);
  const booked = await agent.handleMessage({
    message: `I am Rosa Lind, rosa.lind@example.com, 07700900111. I want hygiene on ${whenText(slot.startMs)}`
  });
  await settle();
  const before = calls.length;

  await appointments.cancelAppointment({ reference: booked.appointment.reference, actor: 'test' });
  await settle();

  assert.equal(calls.length, before + 1);
  const payload = JSON.parse(calls.at(-1).options.body);
  assert.equal(payload.event, 'appointment.cancelled');
  assert.equal(payload.appointment.status, 'cancelled');

  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.BRIDGE_WEBHOOK_URL;
});

test('a failing endpoint keeps the event pending for retry instead of losing it', async () => {
  process.env.BRIDGE_WEBHOOK_URL = 'https://down.example/hooks';
  stubFetch(() => new Response('boom', { status: 503 }));

  const { slot } = nextSlot('checkup', Date.now() + 20 * ctx.time.DAY_MS);
  await agent.handleMessage({
    message: `I am Retry Tester, retry.tester@example.com, 07700900222. I want a check-up on ${whenText(slot.startMs)}`
  });
  await settle();

  const row = db.get('SELECT * FROM bridge_outbox ORDER BY id DESC LIMIT 1');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /503/);
  assert.ok(row.next_at, 'a retry time is set');

  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.BRIDGE_WEBHOOK_URL;
});

test('without a bridge URL nothing is queued or sent', async () => {
  globalThis.fetch = async () => {
    throw new Error('network must not be used');
  };
  const before = db.get('SELECT COUNT(*) AS n FROM bridge_outbox').n;
  const { slot } = nextSlot('checkup', Date.now() + 26 * ctx.time.DAY_MS);
  await agent.handleMessage({
    message: `I am Quiet Tester, quiet.tester@example.com, 07700900333. I want a check-up on ${whenText(slot.startMs)}`
  });
  await settle();
  const after = db.get('SELECT COUNT(*) AS n FROM bridge_outbox').n;
  assert.equal(after, before);
  assert.equal((await bridge.flushBridgeOutbox()).disabled, true);
  globalThis.fetch = ORIGINAL_FETCH;
});

test('reconciliation identifies missing, cancelled and stray bookings', () => {
  const local = [
    { reference: 'BS-1', status: 'confirmed', startLocal: '2026-11-24 10:00' },
    { reference: 'BS-2', status: 'confirmed', startLocal: '2026-11-24 11:00' },
    { reference: 'BS-3', status: 'cancelled', startLocal: '2026-11-24 12:00' }
  ];
  const remote = [
    { reference: 'BS-1', status: 'confirmed' },
    { reference: 'BS-2', status: 'cancelled' },
    { reference: 'BS-9', status: 'confirmed' }
  ];

  const report = bridge.compareAppointments(local, remote);
  assert.deepEqual(report.matched.map((row) => row.reference), ['BS-1']);
  assert.deepEqual(report.statusMismatch.map((row) => row.appointment.reference), ['BS-2']);
  assert.deepEqual(report.onlyRemotely.map((row) => row.reference), ['BS-9']);
  assert.equal(report.missingRemotely.length, 0);

  const missing = bridge.compareAppointments([local[1]], []);
  assert.equal(missing.missingRemotely[0].reference, 'BS-2');
});
