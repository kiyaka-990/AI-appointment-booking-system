import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicConfig, business, findService, getConfig, ownerAlertSettings } from './lib/config.js';
import { handleMessage, ensureConversation, conversationMessages, loadConversation } from './lib/agent.js';
import { availabilityCalendar, checkSlot, slotsForDay, suggestAlternatives } from './lib/availability.js';
import {
  appointmentEvents,
  cancelAppointment,
  createAppointment,
  getAppointmentByReference,
  listAppointments,
  remindersFor,
  rescheduleAppointment
} from './lib/appointments.js';
import { customerTimeline, getCustomer, listCustomers, normalisePhone, upsertCustomer } from './lib/crm.js';
import { attemptDelivery, deliverRows, listOutbox, processOutbox } from './lib/notifications.js';
import { FAULT_KEYS, listFaults, resetFaults, setFaults } from './lib/faults.js';
import { aiStatus } from './lib/ai.js';
import { channelProvider, deliverySummary } from './lib/messaging.js';
import { flushBridgeOutbox, listBridgeOutbox } from './lib/bridge.js';
import { leaveWaitlist, listWaitlist } from './lib/waitlist.js';
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from './lib/webhooks.js';
import { AppError, ERROR_CODES } from './lib/errors.js';
import { parseDateTime } from './lib/parse-datetime.js';
import { all, audit, closeDatabase, nowIso } from './lib/db.js';
import { STAFF_CHANNEL, subscribe } from './lib/events.js';
import {
  assertStaff,
  authConfig,
  clearSessionCookie,
  issueSession,
  readSession,
  verifyCredentials,
  warnAboutAuth
} from './lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const PAGES = {
  '/': 'index.html',
  '/admin': 'admin.html',
  '/admin/': 'admin.html',
  '/login': 'login.html',
  '/login/': 'login.html'
};

/**
 * Sites allowed to embed the booking widget (EMBED_ORIGINS, comma separated).
 * Empty means the chat cannot be framed anywhere, which is the default.
 */
function embedOrigins() {
  return String(process.env.EMBED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => /^https?:\/\/[^\s]+$/.test(origin));
}

function securityHeaders() {
  const origins = embedOrigins();
  const headers = {
    'content-security-policy':
      `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self';` +
      ` frame-ancestors ${origins.length ? `'self' ${origins.join(' ')}` : "'none'"}; base-uri 'none'; form-action 'self'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
    'cross-origin-opener-policy': 'same-origin'
  };
  // X-Frame-Options would still block the iframe in older browsers.
  if (!origins.length) headers['x-frame-options'] = 'DENY';
  // Only meaningful over HTTPS; harmless otherwise.
  if (process.env.NODE_ENV === 'production') {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/** Clamp a caller-supplied page size so one request cannot scan the database. */
function boundedLimit(value, fallback = 200, max = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** Endpoints that expose customer data, money or workflow controls. */
const STAFF_API = [
  /^\/api\/appointments(\/|$|\?)/,
  /^\/api\/customers(\/|$|\?)/,
  /^\/api\/notifications(\/|$|\?)/,
  /^\/api\/outbox(\/|$|\?)/,
  /^\/api\/audit(\/|$|\?)/,
  /^\/api\/faults(\/|$|\?)/,
  /^\/api\/conversations(\/|$|\?)/,
  /^\/api\/admin(\/|$|\?)/
];

/* ------------------------------------------------------------------ helpers */

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function sendError(res, error) {
  if (error instanceof AppError) {
    sendJson(res, error.status, {
      error: {
        code: error.code,
        message: error.userMessage,
        retryable: error.retryable,
        details: error.details
      }
    });
    return;
  }
  if (error?.code === 'ERR_SQLITE_ERROR' || /disk I\/O error|database is locked/i.test(error?.message ?? '')) {
    console.error('[server] database error:', error.message);
    sendJson(res, 503, {
      error: {
        code: 'CALENDAR_UNAVAILABLE',
        message: 'The booking database is unavailable right now, so nothing was confirmed. Please try again shortly.',
        retryable: true
      }
    });
    return;
  }
  console.error('[server] unhandled error:', error);
  sendJson(res, 500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Nothing was confirmed.',
      retryable: true
    }
  });
}

function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request body is too large.', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function readText(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request body is too large.', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Accepts ISO 8601, epoch milliseconds, or the same natural language the chat uses. */
function parseStart(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = parseDateTime(text, { timeZone: business().timezone, now: Date.now() });
  return parsed ? parsed.startMs : null;
}

function requireStart(value) {
  const ms = parseStart(value);
  if (!Number.isFinite(ms)) {
    throw new AppError(
      ERROR_CODES.INVALID_DATETIME,
      'I could not understand that date. Use an ISO timestamp or something like "Tuesday at 2pm".'
    );
  }
  return ms;
}

const buckets = new Map();

function recordHit(key, windowMs) {
  const timestamp = Date.now();
  const current = buckets.get(key);
  if (!current || timestamp - current.windowAt > windowMs) {
    buckets.set(key, { count: 1, windowAt: timestamp });
    return;
  }
  current.count += 1;
}

function assertWithinLimit(key, limit, windowMs) {
  const current = buckets.get(key);
  if (current && Date.now() - current.windowAt <= windowMs && current.count >= limit) {
    throw new AppError(ERROR_CODES.RATE_LIMITED, 'Too many requests. Please wait a moment.', {
      status: 429,
      retryable: true
    });
  }
}

function rateLimit(key, { limit = 60, windowMs = 60_000 } = {}) {
  assertWithinLimit(key, limit, windowMs);
  recordHit(key, windowMs);
}

/**
 * Best-effort client IP for rate-limit buckets and audit entries. A proxy
 * chain is only honoured when TRUST_PROXY=1; otherwise any client could spoof
 * X-Forwarded-For to escape the bucket it shares.
 */
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    // Fly.io's proxy reports the connecting client in Fly-Client-IP, which a
    // caller cannot forge when traffic arrives through the Fly proxy.
    const flyIp = String(req.headers['fly-client-ip'] ?? '').trim();
    if (flyIp) return flyIp;
    const first = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function secretEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasApiKey(req) {
  const expected = process.env.API_KEY;
  if (!expected) return false;
  return secretEqual(req.headers['x-api-key'], expected);
}

function requireWebhookToken(req) {
  const expected = process.env.WEBHOOK_TOKEN;
  if (!expected) return;
  if (!secretEqual(req.headers['x-webhook-token'], expected)) {
    throw new AppError(ERROR_CODES.UNAUTHORISED, 'Invalid webhook token.', { status: 401 });
  }
}

/** Browsers always send Origin on cross-site writes; reject anything else. */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost !== req.headers.host) {
    throw new AppError(ERROR_CODES.UNAUTHORISED, 'Request origin is not allowed.', { status: 403 });
  }
}

function authoriseStaff(req, method) {
  const session = readSession(req);
  if (session) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) assertSameOrigin(req);
    return session;
  }
  if (hasApiKey(req)) return { user: 'api-key', viaApiKey: true };
  throw new AppError(ERROR_CODES.UNAUTHORISED, 'Staff sign-in required.', { status: 401 });
}

/**
 * Open a server-sent-event stream for one pub/sub channel. The caller is
 * responsible for authenticating staff-scoped streams before calling this.
 */
function openEventStream(req, res, channel) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': connected\n\n');
  const unsubscribe = subscribe(channel, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/**
 * CSV cell. Besides quoting, customer-supplied text is neutralised when it
 * begins with a spreadsheet-significant character (=, +, -, @, tab): Excel and
 * Sheets would otherwise execute it as a formula (CSV formula injection) when
 * staff open the diary export.
 */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]|^\s+[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/* ------------------------------------------------------------------- routes */

function health() {
  const ownerAlert = ownerAlertSettings();
  return {
    ok: true,
    business: business().name,
    database: process.env.DATABASE_PATH || 'data/booking.db',
    ai: aiStatus(),
    delivery: deliverySummary(),
    ownerAlert: {
      channel: ownerAlert.channel,
      configured: Boolean(ownerAlert.phone),
      provider: ownerAlert.phone ? channelProvider(ownerAlert.channel) : null
    },
    scheduler: schedulerConfig(),
    staffAuth: authConfig().usingDemoPassword ? 'demo-password' : 'configured',
    apiKey: Boolean(process.env.API_KEY),
    time: nowIso()
  };
}

/** Built-in reminder/bridge worker: on by default, off with SCHEDULER_ENABLED=0. */
function schedulerConfig() {
  const enabled = process.env.SCHEDULER_ENABLED !== '0';
  const parsed = Number(process.env.SCHEDULER_INTERVAL_MS || 60_000);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 60_000;
  return { enabled, intervalMs };
}

/**
 * Run the reminder queue and the bridge flush on a timer, so a small
 * deployment needs no external cron. Overlap with an external cron (or another
 * instance) is safe: every outbox row is atomically claimed before sending.
 */
function startScheduler() {
  const { enabled, intervalMs } = schedulerConfig();
  if (!enabled) return null;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    Promise.all([processOutbox(), flushBridgeOutbox()])
      .then(([notifications, bridge]) => {
        if (notifications.processed || bridge.processed) {
          console.log(
            `[scheduler] ${notifications.processed} notification(s) processed, ${bridge.sent} bridge event(s) sent`
          );
        }
      })
      .catch((error) => {
        console.warn(`[scheduler] tick failed: ${error.message}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

function availability(url) {
  const serviceKey = url.searchParams.get('service') || url.searchParams.get('serviceId');
  if (!serviceKey) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'service query parameter is required.');
  }
  const from = url.searchParams.get('from');
  const days = Number(url.searchParams.get('days') || 7);
  const calendar = availabilityCalendar({
    serviceKey,
    fromDate: from,
    days: Number.isFinite(days) ? days : 7,
    timeZone: business().timezone
  });
  if (!calendar.service) {
    throw new AppError(ERROR_CODES.UNKNOWN_SERVICE, 'That service is not offered here.', { status: 404 });
  }
  return calendar;
}

function slotCheck(body) {
  const service = findService(body.service ?? body.serviceId);
  if (!service) throw new AppError(ERROR_CODES.UNKNOWN_SERVICE, 'That service is not offered here.');
  const startMs = requireStart(body.start);
  const check = checkSlot({ startMs, service, timeZone: business().timezone });
  const alternatives = check.available
    ? []
    : suggestAlternatives({
        service,
        fromMs: check.alternativesFrom ?? startMs,
        timeZone: business().timezone
      });
  return {
    service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
    requested: new Date(startMs).toISOString(),
    available: check.available,
    reason: check.reason ?? null,
    message: check.message ?? null,
    alternatives: alternatives.map((slot) => ({
      start: new Date(slot.startMs).toISOString(),
      startMs: slot.startMs,
      label: slot.label
    }))
  };
}

async function chat(body, req) {
  rateLimit(`chat:${clientIp(req)}`);
  if (!body.message || !String(body.message).trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A message is required.');
  }
  // Channel identity (channel/externalId/contact) resumes or creates a
  // conversation keyed to a customer, e.g. their WhatsApp number. That is a
  // server-to-server capability: a browser must not be able to claim another
  // customer's number, read their conversation state or change their bookings.
  const serverDriven = hasApiKey(req);
  return handleMessage({
    conversationId: body.conversationId ?? null,
    message: body.message,
    channel: serverDriven ? (body.channel ?? 'web-chat') : 'web-chat',
    externalId: serverDriven ? (body.externalId ?? null) : null,
    contact: serverDriven ? (body.contact ?? null) : null
  });
}

/** Twilio signs the exact public URL plus the sorted form fields (HMAC-SHA1, base64). */
function validTwilioSignature({ url, params, token, signature }) {
  const payload = url + Object.keys(params).sort().map((key) => `${key}${params[key] ?? ''}`).join('');
  const expected = crypto.createHmac('sha1', token).update(payload).digest('base64');
  const provided = String(signature ?? '');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sendTwiml(res, message) {
  const text = String(message ?? '').slice(0, 1500);
  const body = text
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
  res.end(body);
}

/**
 * Inbound WhatsApp/Kakao-style message from Twilio. The same assistant answers,
 * so availability, booking, cancellation and waitlist all work over chat apps.
 * Twilio expects TwiML back, so the reply is returned inline rather than queued.
 *
 * Twilio retries webhooks it did not acknowledge in time, and a retry re-runs
 * the assistant: a second reply, a second CRM write, even a second booking.
 * Every inbound MessageSid is therefore claimed before the workflow runs and
 * the reply is cached, so retries replay it with no side effects.
 */
async function twilioInbound(req, res) {
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  if (!token) {
    throw new AppError(
      ERROR_CODES.WEBHOOK_UNAVAILABLE,
      'The Twilio webhook is not configured. Set TWILIO_AUTH_TOKEN to enable WhatsApp replies.',
      { status: 503 }
    );
  }

  const raw = await readText(req);
  const params = Object.fromEntries(new URLSearchParams(raw));
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const base = (process.env.PUBLIC_BASE_URL || `${proto}://${req.headers.host}`).replace(/\/$/, '');
  const signingUrl = `${base}${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
  if (!validTwilioSignature({ url: signingUrl, params, token, signature: req.headers['x-twilio-signature'] })) {
    throw new AppError(ERROR_CODES.UNAUTHORISED, 'Invalid Twilio signature.', { status: 403 });
  }

  const message = String(params.Body ?? '').trim();
  const phone = normalisePhone(String(params.From ?? '').replace(/^whatsapp:/i, ''));
  if (!message || !phone) return sendTwiml(res, '');

  const claim = claimWebhookEvent({ provider: 'twilio', eventId: params.MessageSid ?? params.SmsSid ?? params.CallSid });
  if (claim.duplicate) {
    console.warn(`[twilio] replaying webhook event ${claim.record?.event_id} (attempt ${claim.record?.attempts})`);
    if (claim.replay) return sendTwiml(res, claim.replay);
    // The original request is still mid-flight; acknowledge the retry without
    // side effects. The customer's reply goes out from the original request.
    return sendTwiml(res, '');
  }

  try {
    rateLimit(`whatsapp:${phone}`, { limit: 30 });
    const conversation = ensureConversation({
      channel: 'whatsapp',
      externalId: phone,
      contact: { phone }
    });
    const result = await handleMessage({
      conversationId: conversation.id,
      message,
      channel: 'whatsapp',
      externalId: phone
    });
    audit('whatsapp.inbound', {
      actor: `customer:${phone}`,
      detail: { conversationId: conversation.id, intent: result.intent ?? null }
    });
    completeWebhookEvent(claim.record, result.reply);
    return sendTwiml(res, result.reply);
  } catch (error) {
    // Release the claim so Twilio's retry is processed rather than replayed.
    failWebhookEvent(claim.record);
    throw error;
  }
}

async function enquiry(body, req) {
  requireWebhookToken(req);
  rateLimit(`enquiry:${clientIp(req)}`, { limit: 120 });
  const channel = String(body.channel ?? 'webhook');
  if (channel.toLowerCase() === 'whatsapp') {
    // WhatsApp conversations belong to signed Twilio inbound events; a generic
    // webhook must not be able to address a customer's WhatsApp thread.
    throw new AppError(
      ERROR_CODES.UNAUTHORISED,
      'The whatsapp channel is reserved for signed Twilio inbound events.',
      { status: 403 }
    );
  }
  const contact = {
    fullName: body.name ?? body.fullName ?? null,
    email: body.email ?? null,
    phone: body.phone ?? null
  };
  const conversation = ensureConversation({
    channel,
    externalId: body.externalId ?? body.enquiryId ?? null,
    contact
  });
  const lines = [];
  if (body.message) lines.push(String(body.message));
  if (body.service) lines.push(`I am looking for ${body.service}.`);
  if (body.preferredTime) lines.push(`Preferred time: ${body.preferredTime}.`);
  if (!lines.length) lines.push('I would like to make an appointment.');
  return handleMessage({
    conversationId: conversation.id,
    message: lines.join(' '),
    channel: conversation.channel,
    contact
  });
}

function conversationDetail(id) {
  const conversation = loadConversation(id);
  return {
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      customerId: conversation.customer_id,
      summary: conversation.summary,
      structured: conversation.structured ? JSON.parse(conversation.structured) : null,
      state: conversation.stateObject,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at
    },
    messages: conversationMessages(id, 200)
  };
}

function appointmentDetail(reference) {
  const appointment = getAppointmentByReference(reference);
  if (!appointment) {
    throw new AppError(ERROR_CODES.BOOKING_NOT_FOUND, 'No booking with that reference.', { status: 404 });
  }
  return {
    appointment,
    customer: getCustomer(appointment.customerId),
    events: appointmentEvents(appointment.id),
    notifications: remindersFor(appointment.id)
  };
}

async function bookDirect(body) {
  const service = findService(body.service ?? body.serviceId);
  if (!service) {
    throw new AppError(ERROR_CODES.UNKNOWN_SERVICE, 'That service is not offered here.');
  }
  const startMs = requireStart(body.start);
  const customer = upsertCustomer({
    fullName: body.name ?? body.fullName,
    email: body.email,
    phone: body.phone,
    source: body.channel ?? 'api'
  }).customer;
  if (!customer) {
    throw new AppError(ERROR_CODES.MISSING_INFORMATION, 'A full name and contact details are required.');
  }

  const check = checkSlot({ startMs, service, timeZone: business().timezone });
  if (!check.available) {
    throw new AppError(ERROR_CODES.SLOT_TAKEN, check.message, {
      status: 409,
      details: {
        reason: check.reason,
        alternatives: suggestAlternatives({
          service,
          fromMs: check.alternativesFrom ?? startMs,
          timeZone: business().timezone
        }).map((slot) => slot.label)
      }
    });
  }

  const result = createAppointment({
    customer,
    service,
    startMs,
    notes: body.notes ?? null,
    source: body.channel ?? 'api',
    idempotencyKey: body.idempotencyKey ?? null,
    actor: 'api'
  });

  await deliverRows(result.deliveries);

  return {
    appointment: result.appointment,
    customer,
    replayed: result.replayed,
    notifications: remindersFor(result.appointment.id).map((row) => ({
      id: row.id,
      template: row.template,
      status: row.status,
      scheduledFor: row.scheduled_for
    }))
  };
}

function staffSlots(url) {
  const service = findService(url.searchParams.get('service'));
  if (!service) throw new AppError(ERROR_CODES.UNKNOWN_SERVICE, 'That service is not offered here.');
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const slots = slotsForDay({ dayIso: date, service, timeZone: business().timezone });
  return {
    service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
    date,
    slots: slots.map((slot) => ({
      start: new Date(slot.startMs).toISOString(),
      startMs: slot.startMs,
      label: slot.label
    }))
  };
}

function appointmentsCsv(url) {
  const status = url.searchParams.get('status');
  const rows = listAppointments({ status: status || null, limit: 5000 });
  const header = [
    'reference', 'status', 'start_iso', 'start_local', 'service', 'customer',
    'email', 'phone', 'notes', 'source', 'created_at'
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.reference,
        row.status,
        row.start,
        row.startLocal,
        row.serviceName,
        row.customer?.fullName,
        row.customer?.email,
        row.customer?.phone,
        row.notes,
        row.source,
        row.createdAt
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

async function route(req, res) {
  applySecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  // Pages that depend on the staff session.
  if (PAGES[pathname]) {
    if (pathname.startsWith('/admin') && !readSession(req)) return redirect(res, '/login');
    if (pathname.startsWith('/login') && readSession(req)) return redirect(res, '/admin');
    return serveStatic(PAGES[pathname], res);
  }

  if (method === 'GET' && pathname === '/manifest.webmanifest') {
    const cfg = publicConfig();
    const manifest = {
      name: `${cfg.business.name} - Appointments`,
      short_name: cfg.business.name.split(' ').slice(0, 2).join(' '),
      description: 'Book, change or cancel an appointment.',
      start_url: '/?source=pwa',
      scope: '/',
      display: 'standalone',
      background_color: '#f2f6f8',
      theme_color: '#0f766e',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }
      ],
      shortcuts: [{ name: 'Staff dashboard', url: '/admin' }]
    };
    const body = JSON.stringify(manifest);
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store'
    });
    return res.end(body);
  }

  if (!pathname.startsWith('/api/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Malformed path.', { status: 400 });
    }
    return serveStatic(decoded.replace(/^\/+/, ''), res);
  }

  /* --------------------------------------------------------- authentication */

  if (method === 'POST' && pathname === '/api/auth/login') {
    const loginKey = `login:${clientIp(req)}`;
    const loginWindow = 10 * 60_000;
    assertWithinLimit(loginKey, 8, loginWindow);
    const body = await readJson(req);
    if (!verifyCredentials(body.username, body.password)) {
      recordHit(loginKey, loginWindow);
      audit('auth.login_failed', { actor: 'anonymous', detail: { ip: clientIp(req) } });
      throw new AppError(ERROR_CODES.UNAUTHORISED, 'Incorrect username or password.', { status: 401 });
    }
    const session = issueSession(authConfig().user);
    audit('auth.login', { actor: `staff:${authConfig().user}`, detail: { ip: clientIp(req) } });
    res.setHeader('set-cookie', session.cookie);
    return sendJson(res, 200, { authenticated: true, user: authConfig().user, expiresAt: new Date(session.expires).toISOString() });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    res.setHeader('set-cookie', clearSessionCookie());
    return sendJson(res, 200, { authenticated: false });
  }

  if (method === 'GET' && pathname === '/api/auth/session') {
    const session = readSession(req);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      user: session?.user ?? null,
      expiresAt: session ? new Date(session.expires).toISOString() : null,
      auth: { demoPassword: authConfig().usingDemoPassword }
    });
  }

  if (STAFF_API.some((pattern) => pattern.test(pathname))) {
    authoriseStaff(req, method);
  }

  /* --------------------------------------------------------------- public API */

  if (method === 'GET' && pathname === '/api/health') return sendJson(res, 200, health());
  if (method === 'GET' && pathname === '/api/config') return sendJson(res, 200, { ...publicConfig(), ai: aiStatus() });
  if (method === 'GET' && pathname === '/api/services') return sendJson(res, 200, { services: publicConfig().services });
  if (method === 'GET' && pathname === '/api/availability') return sendJson(res, 200, availability(url));
  if (method === 'POST' && pathname === '/api/availability/check') {
    return sendJson(res, 200, slotCheck(await readJson(req)));
  }
  if (method === 'GET' && pathname === '/api/events') {
    const scope = url.searchParams.get('scope');
    if (scope === 'staff') {
      if (!readSession(req)) {
        throw new AppError(ERROR_CODES.UNAUTHORISED, 'Staff sign-in required.', { status: 401 });
      }
      rateLimit(`events:staff:${clientIp(req)}`, { limit: 60, windowMs: 60_000 });
      return openEventStream(req, res, STAFF_CHANNEL);
    }

    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (!/^cnv_[a-zA-Z0-9]{6,32}$/.test(conversationId)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A valid conversationId is required.');
    }
    rateLimit(`events:${clientIp(req)}`, { limit: 30, windowMs: 60_000 });
    return openEventStream(req, res, conversationId);
  }

  if (method === 'POST' && pathname === '/api/chat') {
    return sendJson(res, 200, await chat(await readJson(req), req));
  }
  if (method === 'POST' && pathname === '/api/enquiries') {
    return sendJson(res, 201, await enquiry(await readJson(req), req));
  }
  if (method === 'POST' && pathname === '/api/bookings') {
    if (process.env.API_KEY && !hasApiKey(req)) {
      throw new AppError(ERROR_CODES.UNAUTHORISED, 'A valid x-api-key header is required.', { status: 401 });
    }
    rateLimit(`booking:${clientIp(req)}`);
    return sendJson(res, 201, await bookDirect(await readJson(req)));
  }

  if (method === 'POST' && pathname === '/api/webhooks/twilio') {
    return twilioInbound(req, res);
  }

  /* ---------------------------------------------------------------- staff API */

  const conversationMatch = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && conversationMatch) {
    return sendJson(res, 200, conversationDetail(decodeURIComponent(conversationMatch[1])));
  }

  if (method === 'GET' && pathname === '/api/appointments') {
    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    let rows = listAppointments({
      status: status || null,
      fromMs: from ? requireStart(from) : null,
      toMs: to ? requireStart(to) : null,
      limit: boundedLimit(url.searchParams.get('limit'), 200)
    });
    if (search) {
      rows = rows.filter((row) => {
        const haystack = [
          row.reference,
          row.serviceName,
          row.customer?.fullName,
          row.customer?.email,
          row.customer?.phone
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(search);
      });
    }
    return sendJson(res, 200, { appointments: rows });
  }

  if (method === 'GET' && pathname === '/api/appointments/export.csv') {
    const body = appointmentsCsv(url);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="appointments-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store'
    });
    return res.end(body);
  }

  const appointmentMatch = /^\/api\/appointments\/([^/]+)$/.exec(pathname);
  if (appointmentMatch && method === 'GET') {
    return sendJson(res, 200, appointmentDetail(decodeURIComponent(appointmentMatch[1])));
  }

  const cancelMatch = /^\/api\/appointments\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch && method === 'POST') {
    const body = await readJson(req);
    const result = await cancelAppointment({
      reference: decodeURIComponent(cancelMatch[1]),
      reason: body.reason ?? 'Customer request',
      actor: 'staff'
    });
    audit('api.cancel', { actor: 'staff', entity: 'appointment', entityId: result.appointment.id });
    return sendJson(res, 200, result);
  }

  const rescheduleMatch = /^\/api\/appointments\/([^/]+)\/reschedule$/.exec(pathname);
  if (rescheduleMatch && method === 'POST') {
    const body = await readJson(req);
    const result = await rescheduleAppointment({
      reference: decodeURIComponent(rescheduleMatch[1]),
      startMs: requireStart(body.start ?? body.time ?? body.date),
      actor: 'staff'
    });
    audit('api.reschedule', { actor: 'staff', entity: 'appointment', entityId: result.appointment.id });
    return sendJson(res, 200, result);
  }

  if (method === 'GET' && pathname === '/api/customers') {
    return sendJson(res, 200, {
      customers: listCustomers({
        search: url.searchParams.get('search'),
        limit: boundedLimit(url.searchParams.get('limit'), 200)
      })
    });
  }

  const customerMatch = /^\/api\/customers\/([^/]+)$/.exec(pathname);
  if (customerMatch && method === 'GET') {
    const timeline = customerTimeline(decodeURIComponent(customerMatch[1]));
    if (!timeline) throw new AppError(ERROR_CODES.NOT_FOUND, 'Customer not found.', { status: 404 });
    return sendJson(res, 200, timeline);
  }

  if (method === 'GET' && (pathname === '/api/notifications' || pathname === '/api/outbox')) {
    return sendJson(res, 200, {
      notifications: listOutbox({
        status: url.searchParams.get('status'),
        appointmentId: url.searchParams.get('appointmentId'),
        limit: boundedLimit(url.searchParams.get('limit'), 200)
      })
    });
  }
  if (method === 'POST' && (pathname === '/api/notifications/process' || pathname === '/api/outbox/process')) {
    const [notifications, bridge] = await Promise.all([processOutbox(), flushBridgeOutbox()]);
    return sendJson(res, 200, { ...notifications, bridge });
  }

  if (method === 'GET' && pathname === '/api/waitlist') {
    await assertStaff(req);
    const status = url.searchParams.get('status');
    return sendJson(res, 200, {
      entries: listWaitlist({
        status: status && status !== 'all' ? status : null,
        limit: boundedLimit(url.searchParams.get('limit'), 100)
      })
    });
  }

  const waitlistMatch = /^\/api\/waitlist\/(\d+)$/.exec(pathname);
  if (waitlistMatch && method === 'DELETE') {
    await assertStaff(req);
    return sendJson(res, 200, { entry: leaveWaitlist(Number(waitlistMatch[1])) });
  }

  if (method === 'GET' && pathname === '/api/bridge') {
    await assertStaff(req);
    return sendJson(res, 200, {
      events: listBridgeOutbox({ status: url.searchParams.get('status'), limit: boundedLimit(url.searchParams.get('limit'), 50) })
    });
  }

  const retryMatch = /^\/api\/(?:notifications|outbox)\/(\d+)\/retry$/.exec(pathname);
  if (retryMatch && method === 'POST') {
    const result = await attemptDelivery(Number(retryMatch[1]));
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  if (method === 'GET' && pathname === '/api/faults') {
    return sendJson(res, 200, { faults: listFaults(), keys: FAULT_KEYS });
  }
  if (method === 'POST' && pathname === '/api/faults') {
    return sendJson(res, 200, { faults: setFaults(await readJson(req)) });
  }
  if (method === 'DELETE' && pathname === '/api/faults') {
    resetFaults();
    return sendJson(res, 200, { faults: listFaults() });
  }

  if (method === 'GET' && pathname === '/api/audit') {
    return sendJson(res, 200, {
      entries: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')
    });
  }

  /* ------------------------------------------------------- staff admin actions */

  if (method === 'GET' && pathname === '/api/admin/slots') {
    return sendJson(res, 200, staffSlots(url));
  }

  if (method === 'POST' && pathname === '/api/admin/bookings') {
    const body = await readJson(req);
    const service = findService(body.service ?? body.serviceId);
    if (!service) throw new AppError(ERROR_CODES.UNKNOWN_SERVICE, 'That service is not offered here.');
    const startMs = requireStart(body.start);
    const customer = upsertCustomer({
      fullName: body.name ?? body.fullName,
      email: body.email,
      phone: body.phone,
      source: 'staff-dashboard',
      notes: body.notes ?? null
    }).customer;
    if (!customer) {
      throw new AppError(ERROR_CODES.MISSING_INFORMATION, 'A full name and contact details are required.');
    }
    const result = createAppointment({
      customer,
      service,
      startMs,
      notes: body.notes ?? null,
      source: 'staff-dashboard',
      actor: 'staff'
    });
    await deliverRows(result.deliveries);
    audit('staff.manual_booking', {
      actor: 'staff',
      entity: 'appointment',
      entityId: result.appointment.id,
      detail: { reference: result.appointment.reference }
    });
    return sendJson(res, 201, { appointment: result.appointment, customer });
  }

  throw new AppError(ERROR_CODES.NOT_FOUND, 'Endpoint not found.', { status: 404 });
}

function serveStatic(relative, res) {
  const target = path.resolve(publicDir, relative);
  const insidePublic = target === publicDir || target.startsWith(publicDir + path.sep);
  if (!insidePublic || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache'
  });
  res.end(body);
}

export function createServer() {
  return http.createServer((req, res) => {
    // Correlate every response (and the log line for any failure) with an id:
    // support can ask for it and find the exact request in the logs.
    const requestId = String(req.headers['x-request-id'] ?? crypto.randomUUID())
      .replace(/[^\w-]/g, '')
      .slice(0, 64);
    res.setHeader('x-request-id', requestId);
    route(req, res).catch((error) => {
      console.error(`[server] request ${requestId} failed:`, error);
      sendError(res, error);
    });
  });
}

function start() {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // No .env file; environment variables can still be set externally.
  }
  warnAboutAuth();

  const configuredPort = Number(process.env.PORT);
  const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();

  server.listen(port, host, () => {
    const cfg = getConfig();
    const address = server.address();
    const auth = authConfig();
    const scheduler = startScheduler();
    console.log(`\n${cfg.business.name} - appointment booking workflow`);
    console.log(`  customer chat   http://${host}:${address.port}`);
    console.log(`  staff dashboard http://${host}:${address.port}/admin`);
    console.log(`  timezone        ${cfg.business.timezone}`);
    const assistant = aiStatus();
    console.log(
      `  assistant       ${assistant.enabled ? `${assistant.providerLabel} (${assistant.model})` : `deterministic fallback (${assistant.reason})`}`
    );
    const delivery = deliverySummary();
    console.log(`  email / sms     ${delivery.email} / ${delivery.sms} (mode: ${delivery.mode})`);
    console.log(`  database        ${process.env.DATABASE_PATH || 'data/booking.db'}`);
    console.log(`  staff login     ${auth.user} / ${auth.usingDemoPassword ? 'demo password "brightsmile"' : 'password from environment'}`);
    console.log(
      `  reminders       ${scheduler ? `internal scheduler every ${Math.round(schedulerConfig().intervalMs / 1000)}s` : 'SCHEDULER_ENABLED=0 - point a cron at POST /api/notifications/process'}\n`
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n[server] ${signal} received, closing.`);
      server.close(() => {
        closeDatabase();
        process.exit(0);
      });
      // Open SSE streams and keep-alive sockets would otherwise keep the
      // process alive past the orchestrator's grace period, losing a clean
      // database close. Destroy them so `close` can finish its callback.
      server.closeAllConnections?.();
    });
  }

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
