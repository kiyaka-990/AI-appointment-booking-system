import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

process.env.STAFF_USER = 'staff';
process.env.STAFF_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret';

const ctx = await boot('proxy');
const { createServer } = await import('../src/server.js');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${origin}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

/** Hammer the login endpoint until it throttles; returns whether a 429 appeared. */
async function throttled(headersFor) {
  const headers = typeof headersFor === 'function' ? null : headersFor;
  let limited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'staff', password: `wrong-${attempt}` },
      headers: headers ?? headersFor(attempt)
    });
    if (response.status === 429) limited = true;
  }
  return limited;
}

test('without TRUST_PROXY, spoofed proxy headers cannot split the rate-limit bucket', async () => {
  const trusted = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  try {
    // Every request pretends to be a different client, but without trusting a
    // proxy they all share this socket's bucket and are throttled together.
    assert.equal(
      await throttled((attempt) => ({ 'fly-client-ip': `198.51.100.${attempt}` })),
      true,
      'spoofed Fly-Client-IP values do not create fresh buckets'
    );
  } finally {
    process.env.TRUST_PROXY = trusted;
  }
});

test('with TRUST_PROXY=1, each proxy-reported client is throttled independently', async () => {
  process.env.TRUST_PROXY = '1';
  // Same socket for all of these (the single test fetch), yet each reported
  // client IP must have its own bucket: one attacker cannot exhaust another
  // customer's limit, and Fly's real client IP is honoured.
  const cases = [
    { label: 'Fly-Client-IP', headers: { 'fly-client-ip': '203.0.113.10' } },
    { label: 'Fly-Client-IP (second client)', headers: { 'fly-client-ip': '203.0.113.11' } },
    { label: 'X-Forwarded-For', headers: { 'x-forwarded-for': '203.0.113.12, 10.0.0.1' } }
  ];
  for (const { label, headers } of cases) {
    assert.equal(await throttled(headers), true, `${label} gets its own bucket`);
  }
});