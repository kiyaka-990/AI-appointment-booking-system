import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

process.env.STAFF_USER = 'staff';
process.env.STAFF_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret';

const ctx = await boot('security');
const { createServer } = await import('../src/server.js');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  return fetch(`${origin}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function signIn() {
  const response = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'staff', password: 'test-password' }
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return cookie;
}

test('security headers are set on every response', async () => {
  const response = await request('/api/health');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
});

test('the widget is framed only by origins an operator allows', async () => {
  const blocked = await request('/api/health');
  assert.match(blocked.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(blocked.headers.get('x-frame-options'), 'DENY');

  process.env.EMBED_ORIGINS = 'https://clinic.example, https://www.clinic.example/';
  const allowed = await request('/api/health');
  const csp = allowed.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/clinic\.example https:\/\/www\.clinic\.example;/);
  assert.equal(allowed.headers.get('x-frame-options'), null, 'XFO would still block the iframe');

  delete process.env.EMBED_ORIGINS;
  const again = await request('/api/health');
  assert.match(again.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('the staff dashboard redirects anonymous visitors to the login page', async () => {
  const admin = await request('/admin');
  assert.equal(admin.status, 302);
  assert.equal(admin.headers.get('location'), '/login');

  const login = await request('/login');
  assert.equal(login.status, 200);
});

test('customer data and workflow controls require a session', async () => {
  for (const path of ['/api/appointments', '/api/customers', '/api/audit', '/api/notifications']) {
    const response = await request(path);
    assert.equal(response.status, 401, `${path} must be protected`);
  }

  const cancel = await request('/api/appointments/BS-2026-AAAAA/cancel', {
    method: 'POST',
    body: { reason: 'test' }
  });
  assert.equal(cancel.status, 401);

  const booking = await request('/api/admin/bookings', { method: 'POST', body: {} });
  assert.equal(booking.status, 401);
});

test('public endpoints still work without a session', async () => {
  const config = await request('/api/config');
  assert.equal(config.status, 200);
  const availability = await request('/api/availability?service=checkup&days=1');
  assert.equal(availability.status, 200);
});

test('the public chat endpoint cannot claim another customer conversation identity', async () => {
  // channel/externalId resume a conversation keyed to a customer (e.g. their
  // WhatsApp number). Browsers must not be able to address that identity.
  const response = await request('/api/chat', {
    method: 'POST',
    body: {
      message: 'Hello there, I would like to change my booking',
      channel: 'whatsapp',
      externalId: '+447700901234',
      contact: { fullName: 'Spoofed Customer', phone: '+447700901234' }
    }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.channel, 'web-chat', 'browser callers get an isolated web-chat conversation');

  const hijacked = ctx.db.get(
    "SELECT id FROM conversations WHERE channel = 'whatsapp' AND external_id = '+447700901234'"
  );
  assert.ok(!hijacked, 'no conversation is created or resumed under the spoofed identity');
});

test('the enquiry webhook cannot address the WhatsApp channel', async () => {
  const response = await request('/api/enquiries', {
    method: 'POST',
    body: { message: 'Hello', channel: 'whatsapp', externalId: '+447700901234' }
  });
  assert.equal(response.status, 403, 'WhatsApp conversations belong to signed Twilio inbound events');
});

test('a signed-in session can read bookings and is HttpOnly + SameSite', async () => {
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'staff', password: 'test-password' }
  });
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);

  const cookie = setCookie.split(';')[0];
  const session = await request('/api/auth/session', { cookie });
  assert.equal((await session.json()).authenticated, true);

  const appointments = await request('/api/appointments', { cookie });
  assert.equal(appointments.status, 200);
});

test('a forged session cookie is rejected', async () => {
  const forged = 'bf_staff=eyJ1c2VyIjoic3RhZmYiLCJleHBpcmVzIjo5OTk5OTk5OTk5OTk5fQ.bad-signature';
  const response = await request('/api/appointments', { cookie: forged });
  assert.equal(response.status, 401);
});

test('cross-site writes with a session cookie are blocked', async () => {
  const cookie = await signIn();
  const response = await request('/api/notifications/process', {
    method: 'POST',
    cookie,
    headers: { origin: 'https://evil.example' }
  });
  assert.equal(response.status, 403);
});

test('staff can create a booking, export the diary and retry messages', async () => {
  const cookie = await signIn();

  const availability = await request('/api/availability?service=checkup&days=7', { cookie });
  const calendar = await availability.json();
  const slot = calendar.days.flatMap((day) => day.slots)[0];
  assert.ok(slot, 'availability returned');

  const created = await request('/api/admin/bookings', {
    method: 'POST',
    cookie,
    headers: { origin },
    body: {
      name: 'Walk In',
      email: 'walkin@example.com',
      phone: '07700900888',
      service: 'checkup',
      start: slot.start
    }
  });
  assert.equal(created.status, 201);
  const appointment = (await created.json()).appointment;
  assert.match(appointment.reference, /^BS-\d{4}-[A-Z0-9]{5}$/);

  const csv = await request('/api/appointments/export.csv', { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), new RegExp(appointment.reference));

  const notifications = await request('/api/notifications?status=sent', { cookie });
  const rows = (await notifications.json()).notifications;
  assert.ok(rows.length > 0);

  const retry = await request(`/api/notifications/${rows[0].id}/retry`, {
    method: 'POST',
    cookie,
    headers: { origin }
  });
  assert.equal(retry.status, 200);
});

test('an API key can drive machine endpoints without a cookie', async () => {
  process.env.API_KEY = 'machine-key';
  try {
    const denied = await request('/api/notifications/process', { method: 'POST' });
    assert.equal(denied.status, 401);

    const allowed = await request('/api/notifications/process', {
      method: 'POST',
      headers: { 'x-api-key': 'machine-key' }
    });
    assert.equal(allowed.status, 200);
  } finally {
    delete process.env.API_KEY;
  }
});

// Keep this last: it deliberately exhausts the login rate-limit bucket.
test('wrong credentials are rejected and failures are rate limited', async () => {
  const bad = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'staff', password: 'wrong' }
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  let limited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'staff', password: `wrong-${attempt}` }
    });
    if (response.status === 429) limited = true;
  }
  assert.equal(limited, true, 'repeated failures are throttled');
});
