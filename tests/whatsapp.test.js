import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot } from './helpers.js';

const { db } = await boot('whatsapp');
const { createServer } = await import('../src/server.js');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((resolve) => server.close(resolve)));

const TOKEN = 'test-auth-token';
const WEBHOOK = `${origin}/api/webhooks/twilio`;

function sign(url, params, token) {
  const payload = url + Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return crypto.createHmac('sha1', token).update(payload).digest('base64');
}

async function post(params, { signature, token = TOKEN } = {}) {
  if (token) process.env.TWILIO_AUTH_TOKEN = token;
  else delete process.env.TWILIO_AUTH_TOKEN;
  const body = new URLSearchParams(params).toString();
  return fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature === undefined ? { 'x-twilio-signature': sign(WEBHOOK, params, token ?? '') } : { 'x-twilio-signature': signature })
    },
    body
  });
}

const inbound = {
  From: 'whatsapp:+447700900123',
  To: 'whatsapp:+447700900999',
  MessageSid: 'SM00000000000000000000000000000001',
  Body: 'Hi, what times are free this week?'
};

test('a signed WhatsApp message gets a TwiML reply from the same assistant', async () => {
  const response = await post(inbound);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/xml/);
  const xml = await response.text();
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<Response><Message>/);
  assert.ok(xml.length > 80, 'reply has content');

  const conversation = db.get(
    "SELECT * FROM conversations WHERE channel = 'whatsapp' AND external_id = '+447700900123'"
  );
  assert.ok(conversation, 'conversation created for the WhatsApp number');
  const message = db.get(
    "SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    conversation.id
  );
  assert.ok(message, 'assistant reply stored');
});

test('the second WhatsApp message continues the same conversation', async () => {
  // A new inbound message always carries a new MessageSid; only provider
  // retries repeat the same one (see the dedupe tests below).
  const response = await post({ ...inbound, MessageSid: 'SM00000000000000000000000000000002', Body: 'I am Wanda Reed, wanda.reed@example.com, 07700900123' });
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, /<Response><Message>/);

  const conversations = db.all("SELECT id FROM conversations WHERE channel = 'whatsapp'");
  assert.equal(conversations.length, 1, 'no duplicate conversation for the same number');
  const inboundMessages = db.get(
    "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'user'",
    conversations[0].id
  );
  assert.equal(inboundMessages.count, 2, 'both messages stored on the same conversation');
});

test('a forged signature is rejected', async () => {
  const response = await post(inbound, { signature: 'not-a-real-signature' });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.match(payload.error.message, /signature/i);
});

test('the webhook refuses to run without a Twilio token', async () => {
  const response = await post(inbound, { token: null, signature: 'anything' });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error.message, /TWILIO_AUTH_TOKEN/);
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
});

// --- Webhook de-duplication (provider retries) --------------------------------

const DEDUPE_INBOUND = {
  From: 'whatsapp:+447700900456',
  To: 'whatsapp:+447700900999',
  MessageSid: 'SM00000000000000000000000000DUP01',
  Body: 'Hello, I would like to book a check-up.'
};

test('a retried Twilio webhook is processed once and replays the same reply', async () => {
  const first = await post(DEDUPE_INBOUND);
  assert.equal(first.status, 200);
  const firstXml = await first.text();
  assert.match(firstXml, /<Response><Message>/);

  // Twilio retries when the first delivery does not return in time. The retry
  // must never re-run the assistant: same reply, no new conversation rows.
  const retry = await post(DEDUPE_INBOUND);
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), firstXml, 'the retry replays the stored reply');

  const conversation = db.get(
    "SELECT * FROM conversations WHERE channel = 'whatsapp' AND external_id = '+447700900456'"
  );
  assert.ok(conversation, 'conversation created by the first delivery');
  const counts = db.get(
    "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    conversation.id
  );
  assert.equal(counts.count, 2, 'exactly one user message and one assistant reply (no duplicates)');
});

test('a new message from the same number is still processed normally', async () => {
  const response = await post({ ...DEDUPE_INBOUND, MessageSid: 'SM00000000000000000000000000DUP02', Body: 'Also, do you do hygiene appointments?' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Response><Message>/);

  const conversation = db.get(
    "SELECT * FROM conversations WHERE channel = 'whatsapp' AND external_id = '+447700900456'"
  );
  const userMessages = db.get(
    "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'user'",
    conversation.id
  );
  assert.equal(userMessages.count, 2, 'de-duplication is per event id, not per sender');
});

test('the dedupe store replays completed events and re-opens failed ones', async () => {
  const { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } = await import('../src/lib/webhooks.js');

  const first = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-1' });
  assert.equal(first.duplicate, false, 'first claim owns the event');
  assert.ok(first.record?.id);

  const racing = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-1' });
  assert.equal(racing.duplicate, true, 'a fresh claim is still in flight');
  assert.equal(racing.replay, null, 'nothing to replay yet');

  completeWebhookEvent(first.record, 'See you Tuesday at 2pm.');
  const replay = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-1' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.replay, 'See you Tuesday at 2pm.');

  const failed = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-FAIL' });
  failWebhookEvent(failed.record);
  const retry = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-FAIL' });
  assert.equal(retry.duplicate, false, 'a failed attempt is reprocessed by the next retry');

  // A claim left 'processing' by a crashed worker can be taken over once stale.
  const crashed = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-CRASH' });
  db.run(
    "UPDATE webhook_events SET updated_at = ? WHERE id = ?",
    new Date(Date.now() - 10 * 60_000).toISOString(),
    crashed.record.id
  );
  const takeover = claimWebhookEvent({ provider: 'unit', eventId: 'EVT-CRASH' });
  assert.equal(takeover.duplicate, false, 'a stale claim does not swallow the event');
});
