import crypto from 'node:crypto';
import { AppError, ERROR_CODES } from './errors.js';

/**
 * Staff authentication.
 *
 * - One or more staff accounts can sign in with a shared password configured in
 *   the environment (`STAFF_PASSWORD`, `STAFF_USER`).
 * - Sessions are stateless signed cookies (HMAC-SHA256), HttpOnly and
 *   SameSite=Strict, valid for 8 hours.
 * - Passwords are compared as scrypt digests with a timing-safe comparison.
 */

const COOKIE_NAME = 'bf_staff';
const SESSION_MS = 8 * 60 * 60 * 1000;
const SALT = 'bf-staff-v1';
const DEMO_PASSWORD = 'brightsmile';

let ephemeralSecret = null;
let warned = false;

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralSecret;
}

export function authConfig() {
  return {
    user: process.env.STAFF_USER || 'staff',
    password: process.env.STAFF_PASSWORD || DEMO_PASSWORD,
    usingDemoPassword: !process.env.STAFF_PASSWORD,
    usingEphemeralSecret: !process.env.SESSION_SECRET,
    sessionHours: SESSION_MS / (60 * 60 * 1000)
  };
}

export function warnAboutAuth() {
  const cfg = authConfig();
  if (warned) return;
  warned = true;
  if (cfg.usingDemoPassword) {
    console.warn('[auth] STAFF_PASSWORD is not set - the staff dashboard uses the demo password "brightsmile". Set STAFF_PASSWORD before going live.');
  }
  if (cfg.usingEphemeralSecret) {
    console.warn('[auth] SESSION_SECRET is not set - sessions will not survive a restart. Set SESSION_SECRET before going live.');
  }
}

function digest(password) {
  return crypto.scryptSync(String(password), SALT, 32);
}

// scrypt is deliberately slow; recomputing the configured password's digest on
// every attempt doubles the cost of each sign-in. Cache it per password value.
let cachedPasswordDigest = null;
let cachedPasswordValue = null;

function configuredPasswordDigest() {
  const password = String(authConfig().password);
  if (cachedPasswordDigest && cachedPasswordValue === password) {
    return cachedPasswordDigest;
  }
  cachedPasswordDigest = digest(password);
  cachedPasswordValue = password;
  return cachedPasswordDigest;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const raw = part.slice(index + 1).trim();
    try {
      result[key] = decodeURIComponent(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

function cookie(value, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function verifyCredentials(username, password) {
  const cfg = authConfig();
  if (!username || !password) return false;
  const userOk = safeEqual(String(username).toLowerCase(), cfg.user.toLowerCase());
  const passwordOk = safeEqual(digest(String(password)), configuredPasswordDigest());
  return userOk && passwordOk;
}

export function issueSession(username) {
  const expires = Date.now() + SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ user: username, expires })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  return {
    token,
    expires,
    cookie: cookie(token, SESSION_MS / 1000)
  };
}

export function clearSessionCookie() {
  return cookie('', 0);
}

export function readSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.expires || data.expires < Date.now()) return null;
    return { user: String(data.user ?? 'staff'), expires: data.expires };
  } catch {
    return null;
  }
}

export function assertStaff(req) {
  const session = readSession(req);
  if (!session) {
    throw new AppError(ERROR_CODES.UNAUTHORISED, 'Staff sign-in required.', { status: 401 });
  }
  return session;
}
