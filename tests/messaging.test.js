import test from 'node:test';
import assert from 'node:assert/strict';

import { channelProvider, deliverMessage, deliverySummary } from '../src/lib/messaging.js';

const ORIGINAL_FETCH = globalThis.fetch;
const MANAGED = [
  'NOTIFICATIONS_MODE',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM'
];

function clearEnv() {
  for (const key of MANAGED) delete process.env[key];
  process.env.NOTIFICATIONS_MODE = 'auto';
}

function stub(handler) {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return handler(url, options);
  };
  return () => captured;
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  clearEnv();
});

clearEnv();

test('Resend receives the confirmation as JSON with the API key and a plain-text fallback', async () => {
  process.env.NOTIFICATIONS_MODE = 'auto';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'Clinic <clinic@example.com>';
  const captured = stub(
    () => new Response(JSON.stringify({ id: 'em_123' }), { status: 200, headers: { 'content-type': 'application/json' } })
  );

  assert.equal(channelProvider('email'), 'resend');
  const result = await deliverMessage({
    channel: 'email',
    to: 'jane@example.com',
    subject: 'Your appointment is confirmed',
    text: 'Hello Jane\n\nSee you Tuesday.'
  });

  assert.equal(result.provider, 'resend');
  assert.equal(result.id, 'em_123');

  const call = captured();
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.authorization, 'Bearer re_test_key');
  const body = JSON.parse(call.options.body);
  assert.equal(body.from, 'Clinic <clinic@example.com>');
  assert.deepEqual(body.to, ['jane@example.com']);
  assert.equal(body.subject, 'Your appointment is confirmed');
  assert.match(body.text, /See you Tuesday/);
  assert.match(body.html, /<p>Hello Jane<\/p>/);
});

test('Twilio receives a form-encoded message with basic auth', async () => {
  process.env.NOTIFICATIONS_MODE = 'auto';
  process.env.TWILIO_ACCOUNT_SID = 'AC123';
  process.env.TWILIO_AUTH_TOKEN = 'token456';
  process.env.TWILIO_FROM = '+441234567890';
  const captured = stub(
    () => new Response(JSON.stringify({ sid: 'SM789' }), { status: 201, headers: { 'content-type': 'application/json' } })
  );

  assert.equal(channelProvider('sms'), 'twilio');
  const result = await deliverMessage({ channel: 'sms', to: '+447700900123', text: 'Reminder: tomorrow at 10am.' });

  assert.equal(result.provider, 'twilio');
  assert.equal(result.id, 'SM789');

  const call = captured();
  assert.equal(call.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(call.options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(call.options.headers.authorization, `Basic ${Buffer.from('AC123:token456').toString('base64')}`);
  const body = new URLSearchParams(call.options.body);
  assert.equal(body.get('To'), '+447700900123');
  assert.equal(body.get('From'), '+441234567890');
  assert.equal(body.get('Body'), 'Reminder: tomorrow at 10am.');
});

test('a provider rejection surfaces its own message so the outbox can retry', async () => {
  process.env.NOTIFICATIONS_MODE = 'auto';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'clinic@example.com';
  stub(
    () =>
      new Response(JSON.stringify({ message: 'The brightsmile.example domain is not verified' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
  );

  await assert.rejects(
    () => deliverMessage({ channel: 'email', to: 'jane@example.com', subject: 'x', text: 'y' }),
    /not verified/
  );
});

test('without credentials nothing is sent and console is reported', async () => {
  process.env.NOTIFICATIONS_MODE = 'auto';
  globalThis.fetch = async () => {
    throw new Error('network must not be used');
  };

  assert.equal(channelProvider('email'), 'console');
  assert.equal(channelProvider('sms'), 'console');
  assert.deepEqual(deliverySummary(), { mode: 'auto', email: 'console', sms: 'console' });
  const result = await deliverMessage({ channel: 'email', to: 'a@b.c', subject: 's', text: 't' });
  assert.equal(result.provider, 'console');
});

test('an explicit console mode ignores configured keys', () => {
  process.env.NOTIFICATIONS_MODE = 'console';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.TWILIO_ACCOUNT_SID = 'AC123';
  process.env.TWILIO_AUTH_TOKEN = 'token';
  process.env.TWILIO_FROM = '+441234567890';

  assert.equal(channelProvider('email'), 'console');
  assert.equal(channelProvider('sms'), 'console');
});
