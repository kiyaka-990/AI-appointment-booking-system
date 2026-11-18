import { randomUUID } from 'node:crypto';
import { all, audit, get, nowIso, run } from './db.js';
import { business, findService, getConfig, policies, services as allServices } from './config.js';
import { analyseMessage } from './nlu.js';
import { aiConfig, understandWithLLM } from './ai.js';
import {
  appendCustomerNote,
  getCustomer,
  isValidName,
  normaliseEmail,
  normalisePhone,
  saveConversationInsight,
  upsertCustomer
} from './crm.js';
import { checkSlot, slotsForDay, suggestAlternatives } from './availability.js';
import {
  cancelAppointment,
  createAppointment,
  findActiveAppointmentForContact,
  getAppointmentByReference,
  rescheduleAppointment
} from './appointments.js';
import { deliverRows, enqueue } from './notifications.js';
import { addWaitlist } from './waitlist.js';
import { renderTemplate } from './templates.js';
import { AppError, ERROR_CODES } from './errors.js';
import { formatDate, formatShort, formatTime, isoDate, MINUTE_MS } from './time.js';
import { parseDateTime } from './parse-datetime.js';

const REQUIRED_FIELDS = [
  { key: 'fullName', label: 'your full name', ask: 'askForName' },
  { key: 'email', label: 'an email address', ask: 'askForEmail' },
  { key: 'phone', label: 'a phone number', ask: 'askForPhone' },
  { key: 'serviceId', label: 'the service you want', ask: 'askForService' },
  { key: 'preferredStartMs', label: 'a preferred day and time', ask: 'askForTime' }
];

function tz() {
  return business().timezone;
}

function readState(conversation) {
  try {
    return JSON.parse(conversation.state || '{}');
  } catch {
    return {};
  }
}

function saveState(conversationId, state) {
  run(
    'UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(state),
    nowIso(),
    conversationId
  );
}

export function appendMessage(conversationId, role, content, meta = null) {
  run(
    'INSERT INTO messages (conversation_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)',
    conversationId,
    role,
    content,
    meta ? JSON.stringify(meta) : null,
    nowIso()
  );
}

export function conversationMessages(conversationId, limit = 50) {
  return all(
    'SELECT id, role, content, meta, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?',
    conversationId,
    limit
  );
}

export function loadConversation(conversationId) {
  const row = get('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, 'Conversation not found.', { status: 404 });
  return { ...row, stateObject: readState(row) };
}

export function ensureConversation({ conversationId = null, channel = 'web-chat', externalId = null, contact = null } = {}) {
  if (conversationId) return loadConversation(conversationId);
  if (externalId) {
    const existing = get(
      'SELECT * FROM conversations WHERE channel = ? AND external_id = ?',
      channel,
      externalId
    );
    if (existing) return { ...existing, stateObject: readState(existing) };
  }
  const id = `cnv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const timestamp = nowIso();
  const initialState = contact ? buildSeedState(contact) : {};
  run(
    'INSERT INTO conversations (id, channel, external_id, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    channel,
    externalId,
    'open',
    JSON.stringify(initialState),
    timestamp,
    timestamp
  );
  return { ...get('SELECT * FROM conversations WHERE id = ?', id), stateObject: initialState };
}

function buildSeedState(contact = {}) {
  const state = {};
  if (contact.fullName && isValidName(contact.fullName)) state.fullName = String(contact.fullName).trim();
  const email = normaliseEmail(contact.email);
  if (email) state.email = email;
  const phone = normalisePhone(contact.phone);
  if (phone) state.phone = phone;
  return state;
}

function resolvePreferred(collected = {}, now) {
  if (Number.isFinite(collected.preferredStartMs)) {
    return { startMs: collected.preferredStartMs, hasTime: collected.preferredHasTime ?? true };
  }
  const combined = [collected.preferredDate, collected.preferredTime, collected.preferredDateText]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!combined) return null;
  const parsed = parseDateTime(combined, { timeZone: tz(), now });
  if (!parsed) return null;
  return { startMs: parsed.startMs, hasTime: parsed.hasTime };
}

function mergeCollected(state, collected = {}, now) {
  const next = { ...state };

  if (collected.fullName && isValidName(collected.fullName)) next.fullName = String(collected.fullName).trim();
  const email = normaliseEmail(collected.email);
  if (email) next.email = email;
  const phone = normalisePhone(collected.phone);
  if (phone) next.phone = phone;
  if (collected.service) {
    const service = findService(collected.service);
    if (service) {
      next.serviceId = service.id;
      next.serviceName = service.name;
    }
  }
  const preferred = resolvePreferred(collected, now);
  if (preferred) {
    next.preferredStartMs = preferred.startMs;
    next.preferredHasTime = preferred.hasTime;
    next.preferredLabel = formatShort(preferred.startMs, tz());
  }
  if (collected.notes) {
    const note = String(collected.notes).trim().slice(0, 500);
    if (note) next.notes = next.notes ? `${next.notes} | ${note}`.slice(0, 1000) : note;
  }
  if (collected.reference) next.reference = String(collected.reference).toUpperCase();
  if (collected.reason) next.reason = String(collected.reason).slice(0, 300);
  return next;
}

function missingFields(state) {
  return REQUIRED_FIELDS.filter((field) => !state[field.key]);
}

function askForField(field) {
  const messages = business().conversation;
  if (field.key === 'serviceId') {
    const list = getConfig()
      .services.map((service) => `- ${service.name} (${service.durationMinutes} minutes)`)
      .join('\n');
    return `${messages.askForService ?? 'Which service do you need?'}\n${list}`;
  }
  return messages[field.ask] ?? `Could you share ${field.label}?`;
}

function serviceFor(state) {
  return state.serviceId ? findService(state.serviceId) : null;
}

/**
 * A model sometimes labels "what times are free this week?" as a booking
 * request. When the wording is clearly an availability question and the
 * customer has not picked a slot yet, the deterministic reading wins.
 */
export function resolveIntent(analysis, fallback, state = {}) {
  if (!analysis) return fallback;
  if (fallback?.intent === 'waitlist' && ['book', 'availability', 'provide_info', 'confirm'].includes(analysis.intent)) {
    return { ...analysis, intent: 'waitlist' };
  }
  if (analysis.intent !== 'book' || fallback?.intent !== 'availability') return analysis;
  if (state?.preferredStartMs) return analysis;
  return { ...analysis, intent: 'availability' };
}

/** Tappable time chips for the chat client (label shown, `send` posted back). */
function slotSuggestions(slots = [], limit = 4) {
  return slots.slice(0, limit).map((slot) => ({
    label: formatTime(slot.startMs, tz()),
    send: `${formatDate(slot.startMs, tz())} at ${formatTime(slot.startMs, tz())}`
  }));
}

function alternativesReply({ service, alternatives, intro, extra = {} }) {
  const cfg = business();
  if (!alternatives.length) {
    return [
      `${intro ?? 'That time is not available.'}`,
      `I could not find anything free for ${service.name} in the next two weeks.`,
      `Call us on ${cfg.supportPhone} and we will fit you in, or tell me a different day.`
    ].join('\n');
  }
  const lines = alternatives.map((slot) => `- ${formatShort(slot.startMs, tz())}`).join('\n');
  return [
    intro ?? 'That time is not available.',
    `The nearest openings for ${service.name} are:`,
    lines,
    extra.footer ?? 'Which of these works for you?'
  ].join('\n');
}

function confirmationReply({ appointment, customer, service }) {
  const cfg = business();
  const firstName = String(customer.full_name ?? 'there').split(' ')[0];
  return [
    `You're booked, ${firstName}. Here are the details:`,
    '',
    `Name: ${customer.full_name}`,
    `Service: ${service.name}`,
    `Date: ${formatDate(appointment.startMs, tz())}`,
    `Time: ${formatTime(appointment.startMs, tz())}`,
    `Reference: ${appointment.reference}`,
    `Where: ${cfg.location}`,
    '',
    service.confirmationNote ?? cfg.bookingInstructions,
    '',
    `A confirmation email is on its way to ${customer.email}, and I will remind you 24 hours and 1 hour before.`,
    `Reply CANCEL ${appointment.reference} or RESCHEDULE ${appointment.reference} if anything changes.`
  ].join('\n');
}

function staffAlert({ subject, detail, channel, appointmentId = null }) {
  const cfg = business();
  const rendered = renderTemplate('staff-alert', {
    customer: { full_name: 'Customer', email: null },
    service: { name: 'n/a' },
    appointment: null,
    tz: tz(),
    extra: { title: subject, detail, channel }
  });
  return enqueue({
    channel: 'email',
    recipient: cfg.supportEmail,
    template: 'staff-alert',
    subject: rendered.subject,
    body: rendered.body,
    appointmentId
  });
}

async function identifyAppointment(state, now) {
  if (state.reference) {
    const appointment = getAppointmentByReference(state.reference);
    if (!appointment) return { appointment: null, reason: 'NOT_FOUND' };
    if (appointment.status !== 'confirmed' && appointment.status !== 'pending') {
      return { appointment, reason: 'INACTIVE' };
    }
    const customer = getCustomer(appointment.customerId);
    if (!customer) return { appointment, customer: null, reason: 'NO_CUSTOMER' };
    const emailMatches = !state.email || !customer.email || customer.email === state.email;
    const phoneMatches = !state.phone || !customer.phone || customer.phone === state.phone;
    if (!emailMatches || !phoneMatches) return { appointment, customer, reason: 'CONTACT_MISMATCH' };
    return { appointment, customer };
  }
  const appointment = findActiveAppointmentForContact({ email: state.email, phone: state.phone });
  if (!appointment) return { appointment: null, reason: state.email || state.phone ? 'NOT_FOUND' : 'NEED_IDENTIFIER' };
  return { appointment, customer: getCustomer(appointment.customerId) };
}

async function cancelFlow(ctx) {
  const { state, conversation, analysis, now } = ctx;
  if (analysis.collected?.reference) state.reference = analysis.collected.reference;
  const found = await identifyAppointment(state, now);

  if (!found.appointment) {
    const reply =
      found.reason === 'NEED_IDENTIFIER'
        ? 'I can cancel that for you. What is the booking reference, or the email address you booked with?'
        : 'I could not find an active booking with those details. Could you check the reference or the email you used?';
    return {
      reply,
      state: { ...state, stage: 'cancel_identify' },
      actions: ['cancel_needs_identifier'],
      error: { code: ERROR_CODES.BOOKING_NOT_FOUND }
    };
  }

  if (found.reason === 'CONTACT_MISMATCH') {
    return {
      reply:
        'That reference is on file, but it does not match the contact details I have for this conversation. To protect the booking, could you confirm the email address or phone number used for it?',
      state: { ...state, stage: 'cancel_identify' },
      actions: ['cancel_verification_failed'],
      error: { code: 'CONTACT_MISMATCH' }
    };
  }

  if (found.reason === 'INACTIVE') {
    return {
      reply: `Booking ${found.appointment.reference} is already ${found.appointment.status}, so there is nothing to cancel.`,
      state,
      actions: ['cancel_noop'],
      error: { code: ERROR_CODES.BOOKING_ALREADY_CANCELLED }
    };
  }

  const cancelled = await cancelAppointment({
    appointment: found.appointment,
    reason: state.reason ?? 'Customer request',
    actor: `agent:${conversation.channel}`,
    now
  });

  const serviceName = found.appointment.serviceName;
  const when = formatShort(found.appointment.startMs, tz());
  return {
    reply: [
      `Cancelled. Your ${serviceName} on ${when} (${cancelled.appointment.reference}) has been removed from the calendar.`,
      `A cancellation email is on its way to ${found.customer?.email ?? 'you'}.`,
      'If you would like a different time instead, just tell me the day and I will find something.'
    ].join('\n'),
    state: {
      ...state,
      stage: 'cancelled',
      lastAppointmentRef: cancelled.appointment.reference,
      proposedSlotMs: null,
      preferredStartMs: null
    },
    appointment: cancelled.appointment,
    actions: ['booking_cancelled', 'cancellation_sent']
  };
}

async function rescheduleFlow(ctx) {
  const { state, conversation, analysis, now } = ctx;
  if (analysis.collected?.reference) state.reference = analysis.collected.reference;
  const found = await identifyAppointment(state, now);

  if (!found.appointment) {
    const reply =
      found.reason === 'NEED_IDENTIFIER'
        ? 'I can move that for you. What is the booking reference, or the email address you booked with?'
        : 'I could not find an active booking with those details. Could you check the reference or the email you used?';
    return {
      reply,
      state: { ...state, stage: 'reschedule_identify' },
      actions: ['reschedule_needs_identifier'],
      error: { code: ERROR_CODES.BOOKING_NOT_FOUND }
    };
  }

  if (found.reason === 'CONTACT_MISMATCH') {
    return {
      reply:
        'That reference is on file but it does not match the contact details here. To protect the booking, could you confirm the email or phone number used when it was made?',
      state: { ...state, stage: 'reschedule_identify' },
      actions: ['reschedule_verification_failed'],
      error: { code: 'CONTACT_MISMATCH' }
    };
  }

  if (found.reason === 'INACTIVE') {
    return {
      reply: `Booking ${found.appointment.reference} is ${found.appointment.status}, so it cannot be moved. Shall I book a new appointment instead?`,
      state,
      actions: ['reschedule_noop'],
      error: { code: ERROR_CODES.BOOKING_ALREADY_CANCELLED }
    };
  }

  const service = findService(found.appointment.serviceId) ?? {
    id: found.appointment.serviceId,
    name: found.appointment.serviceName,
    durationMinutes: Math.round((found.appointment.endMs - found.appointment.startMs) / MINUTE_MS)
  };
  // Only treat the stored time as the target when the customer just gave it,
  // or when the previous turn asked them for one. Otherwise "reschedule REF"
  // would silently move the booking to the time it already has.
  const suppliedNewTime = Boolean(
    analysis.collected?.preferredStartMs || analysis.collected?.preferredDateText
  );
  const desired =
    suppliedNewTime || state.stage === 'reschedule_collect_time' ? state.preferredStartMs : null;

  if (!desired) {
    return {
      reply: `Right, I have ${found.appointment.reference} for ${service.name} on ${formatShort(found.appointment.startMs, tz())}. What day and time would you prefer instead?`,
      state: {
        ...state,
        stage: 'reschedule_collect_time',
        rescheduleRef: found.appointment.reference,
        lastAppointmentRef: found.appointment.reference,
        preferredStartMs: null,
        proposedSlotMs: null
      },
      actions: ['reschedule_awaiting_time']
    };
  }

  const check = checkSlot({
    startMs: desired,
    service,
    now,
    timeZone: tz(),
    ignoreAppointmentId: found.appointment.id
  });

  if (!check.available) {
    const alternatives = suggestAlternatives({
      service,
      fromMs: check.alternativesFrom ?? desired,
      now,
      ignoreAppointmentId: found.appointment.id
    });
    const reply = alternativesReply({
      service,
      alternatives,
      intro: `${formatShort(desired, tz())} is not available for ${service.name} (${check.message})`,
      extra: { footer: 'Which of those times should I move it to?' }
    });
    return {
      reply,
      state: {
        ...state,
        stage: 'reschedule_collect_time',
        rescheduleRef: found.appointment.reference,
        proposedSlotMs: alternatives[0]?.startMs ?? null,
        preferredStartMs: null
      },
      suggestions: slotSuggestions(alternatives),
      actions: ['reschedule_alternatives_suggested'],
      error: { code: check.reason }
    };
  }

  const moved = await rescheduleAppointment({
    appointment: found.appointment,
    startMs: desired,
    actor: `agent:${conversation.channel}`,
    now
  });

  return {
    reply: [
      `Moved. ${service.name} is now ${formatDate(moved.appointment.startMs, tz())} at ${formatTime(moved.appointment.startMs, tz())}.`,
      `Reference stays ${moved.appointment.reference}.`,
      `An updated confirmation is on its way to ${found.customer?.email ?? 'you'}, and the reminders have been reset.`
    ].join('\n'),
    state: {
      ...state,
      stage: 'booked',
      lastAppointmentRef: moved.appointment.reference,
      proposedSlotMs: null,
      preferredStartMs: moved.appointment.startMs
    },
    appointment: moved.appointment,
    actions: ['booking_rescheduled', 'confirmation_sent', 'reminders_rescheduled']
  };
}

async function bookingFlow(ctx) {
  const { state, conversation, analysis, now } = ctx;
  const cfg = business();
  const missing = missingFields(state);

  if (missing.length) {
    const field = missing[0];
    const extra = missing.length > 1 ? ` I will also need ${missing.slice(1).map((f) => f.label).join(', then ')}.` : '';
    return {
      reply: `${askForField(field)}${extra}`,
      state: { ...state, stage: 'collecting' },
      actions: ['requested_information'],
      error: { code: ERROR_CODES.MISSING_INFORMATION, fields: missing.map((f) => f.key) }
    };
  }

  const service = serviceFor(state);
  if (!service) {
    return {
      reply: askForField({ key: 'serviceId' }),
      state: { ...state, serviceId: null, stage: 'collecting' },
      actions: ['requested_information'],
      error: { code: ERROR_CODES.UNKNOWN_SERVICE }
    };
  }

  // The customer may already hold a booking around this time. Name it instead
  // of treating their own appointment as a competing one.
  if (state.preferredStartMs) {
    const existing = findActiveAppointmentForContact({ email: state.email, phone: state.phone });
    const windowMs = (policies().duplicateWindowMinutes ?? 1440) * MINUTE_MS;
    if (existing && Math.abs(existing.startMs - state.preferredStartMs) <= windowMs) {
      return {
        reply: [
          `You already have ${existing.serviceName} booked for ${formatShort(existing.startMs, tz())} (${existing.reference}).`,
          `I can move it to another time or cancel it — just tell me which.`
        ].join('\n'),
        state: { ...state, stage: 'booked', lastAppointmentRef: existing.reference, proposedSlotMs: null },
        appointment: existing,
        actions: ['duplicate_detected'],
        error: { code: ERROR_CODES.DUPLICATE_BOOKING }
      };
    }
  }

  // A date without a time: offer that day's openings.
  if (state.preferredHasTime === false) {
    const dayIso = isoDate(state.preferredStartMs, tz());
    const daySlots = slotsForDay({ dayIso, service, now, timeZone: tz() });
    if (!daySlots.length) {
      const alternatives = suggestAlternatives({
        service,
        fromMs: state.preferredStartMs + 24 * 60 * MINUTE_MS,
        now
      });
      return {
        reply: alternativesReply({
          service,
          alternatives,
          intro: `We do not have anything free on ${formatDate(state.preferredStartMs, tz())}.`
        }),
        state: {
          ...state,
          stage: 'awaiting_confirmation',
          proposedSlotMs: alternatives[0]?.startMs ?? null,
          preferredStartMs: null
        },
        suggestions: slotSuggestions(alternatives),
        actions: ['alternatives_suggested'],
        error: { code: checkSlot({ startMs: state.preferredStartMs, service, now }).reason }
      };
    }
    const shortlist = daySlots.slice(0, 4);
    return {
      reply: [
        `${formatDate(shortlist[0].startMs, tz())} has these openings for ${service.name}:`,
        shortlist.map((slot) => `- ${formatTime(slot.startMs, tz())}`).join('\n'),
        `Which time would you like?`
      ].join('\n'),
      state: {
        ...state,
        stage: 'awaiting_confirmation',
        proposedSlotMs: shortlist[0].startMs,
        proposedSlotList: shortlist.map((slot) => slot.startMs),
        preferredStartMs: shortlist[0].startMs,
        preferredHasTime: true
      },
      suggestions: slotSuggestions(shortlist),
      actions: ['slots_offered']
    };
  }

  const check = checkSlot({ startMs: state.preferredStartMs, service, now, timeZone: tz() });

  if (!check.available) {
    const alternatives = suggestAlternatives({
      service,
      fromMs: check.alternativesFrom ?? state.preferredStartMs,
      now
    });
    return {
      reply: alternativesReply({
        service,
        alternatives,
        intro: `${formatShort(state.preferredStartMs, tz())} is not available for ${service.name}. ${check.message}`
      }),
      state: {
        ...state,
        stage: 'awaiting_confirmation',
        proposedSlotMs: alternatives[0]?.startMs ?? null,
        proposedSlotList: alternatives.map((slot) => slot.startMs),
        preferredStartMs: null
      },
      suggestions: slotSuggestions(alternatives),
      actions: ['alternatives_suggested'],
      error: { code: check.reason }
    };
  }

  const wantsToBook = analysis.intent === 'book' || analysis.intent === 'confirm';
  if (!wantsToBook) {
    return {
      reply: [
        `${formatDate(state.preferredStartMs, tz())} at ${formatTime(state.preferredStartMs, tz())} is free for ${service.name}.`,
        'Shall I book it in?'
      ].join('\n'),
      state: {
        ...state,
        stage: 'awaiting_confirmation',
        proposedSlotMs: state.preferredStartMs,
        proposedSlotList: [state.preferredStartMs]
      },
      actions: ['slot_proposed']
    };
  }

  // Book: availability was verified immediately above, and is re-checked inside
  // the write transaction, so a race here cannot double-book.
  const startMs = state.proposedSlotMs ?? state.preferredStartMs;
  const recheck = checkSlot({ startMs, service, now, timeZone: tz() });
  if (!recheck.available && startMs !== state.preferredStartMs) {
    // The customer picked a previously offered alternative that has since gone.
    const alternatives = suggestAlternatives({ service, fromMs: check.alternativesFrom, now });
    return {
      reply: alternativesReply({
        service,
        alternatives,
        intro: 'That time was taken while we were talking.'
      }),
      state: { ...state, stage: 'awaiting_confirmation', proposedSlotMs: alternatives[0]?.startMs ?? null },
      actions: ['alternatives_suggested'],
      error: { code: ERROR_CODES.SLOT_TAKEN }
    };
  }

  const crm = upsertCustomer({
    fullName: state.fullName,
    email: state.email,
    phone: state.phone,
    source: conversation.channel,
    notes: state.notes ?? null
  });
  if (!crm.customer) {
    return {
      reply: 'I could not save your details, so I have not booked anything. Could you confirm your full name and the best email and phone number?',
      state,
      actions: ['crm_rejected'],
      error: { code: ERROR_CODES.CRM_UNAVAILABLE }
    };
  }

  const result = createAppointment({
    customer: crm.customer,
    service,
    startMs,
    notes: state.notes ?? null,
    source: conversation.channel,
    conversationId: conversation.id,
    actor: `agent:${conversation.channel}`,
    now
  });

  await deliverRows(result.deliveries, { now });

  appendCustomerNote(crm.customer.id, `Booked ${service.name} on ${formatShort(startMs, tz())} (${result.appointment.reference}).`);

  return {
    reply: confirmationReply({
      appointment: result.appointment,
      customer: crm.customer,
      service
    }),
    state: {
      ...state,
      stage: 'booked',
      customerId: crm.customer.id,
      lastAppointmentRef: result.appointment.reference,
      proposedSlotMs: null,
      proposedSlotList: null
    },
    appointment: result.appointment,
    actions: ['booking_created', 'crm_updated', 'confirmation_sent', 'reminders_scheduled']
  };
}

async function escalationFlow(ctx) {
  const { state, conversation, analysis, now } = ctx;
  const cfg = business();
  const alert = staffAlert({
    subject: `Urgent enquiry from ${state.fullName ?? 'unknown customer'}`,
    detail: analysis.summary ?? analysis.reply ?? 'Urgent language detected in chat.',
    channel: conversation.channel
  });
  await deliverRows([alert?.id], { now });
  return {
    reply: cfg.escalationMessage,
    state: { ...state, stage: 'escalated', escalated: true },
    actions: ['escalated', 'staff_alerted'],
    error: { code: ERROR_CODES.OUT_OF_SCOPE, reason: 'escalation' }
  };
}

async function outOfScopeFlow(ctx) {
  const { state, conversation, analysis, now } = ctx;
  const alert = staffAlert({
    subject: 'Out-of-scope request needs a human',
    detail: analysis.summary ?? analysis.reply ?? 'Out-of-scope request in chat.',
    channel: conversation.channel
  });
  await deliverRows([alert?.id], { now });
  return {
    reply: `${business().outOfScopeMessage}`,
    state: { ...state, stage: 'handoff', escalated: true },
    actions: ['escalated', 'staff_alerted'],
    error: { code: ERROR_CODES.OUT_OF_SCOPE }
  };
}

function publicState(state) {
  const view = { ...state };
  if (view.customerId) delete view.customerId;
  return view;
}

function historyForModel(conversationId, limit = 12) {
  const rows = conversationMessages(conversationId, limit + 1);
  const trimmed = rows.slice(0, -1).slice(-limit);
  return trimmed
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role, content: row.content }));
}

/**
 * "What times are free?" — answer it instead of starting the details
 * questionnaire. Lists real openings and offers them as tappable chips.
 */
async function availabilityFlow({ state, analysis, now }) {
  const text = analysis?.raw?.message ?? analysis?.text ?? '';
  const list = allServices();

  let service = state.serviceId ? findService(state.serviceId) : null;
  if (!service) service = findService(analysis?.collected?.service ?? text);
  if (!service && list.length === 1) service = list[0];

  if (!service) {
    return {
      reply: ['Happy to check availability. Which service do you need?', ...list.map((item) => `- ${item.name}`)].join('\n'),
      state: { ...state, stage: 'collecting' },
      suggestions: list.slice(0, 4).map((item) => ({
        label: item.name,
        send: `What times are free for ${item.name}?`
      })),
      actions: ['availability_asked_service']
    };
  }

  let slots = [];
  if (state.preferredStartMs) {
    const dayIso = isoDate(state.preferredStartMs, tz());
    slots = slotsForDay({ dayIso, service, now, timeZone: tz() });
    if (!slots.length) {
      slots = suggestAlternatives({ service, fromMs: state.preferredStartMs, now });
    }
  } else {
    slots = suggestAlternatives({ service, fromMs: now, now });
  }

  if (!slots.length) {
    return {
      reply: `I could not find anything free for ${service.name} in the next few weeks. Would you like me to check a different service, or shall I ask the team to call you?`,
      state: { ...state, stage: 'collecting' },
      suggestions: [
        { label: 'Check another service', send: 'What services do you offer?' },
        { label: 'Ask the team to call', say: 'I need to speak to someone' }
      ],
      actions: ['availability_empty']
    };
  }

  const shortlist = slots.slice(0, 4);
  return {
    reply: [
      `Here are the next openings for ${service.name}:`,
      shortlist.map((slot) => `- ${formatShort(slot.startMs, tz())}`).join('\n'),
      'Tap a time, or tell me another day that suits you.'
    ].join('\n'),
    state: {
      ...state,
      serviceId: service.id,
      stage: 'collecting',
      proposedSlotMs: shortlist[0].startMs,
      proposedSlotList: shortlist.map((slot) => slot.startMs),
      preferredStartMs: null
    },
    suggestions: slotSuggestions(shortlist),
    actions: ['availability_listed']
  };
}

/**
 * "Nothing works, let me know if something opens" — collect the contact details
 * and put the customer on the waiting list for that service.
 */
async function waitlistFlow({ state, analysis, now }) {
  const list = allServices();
  let service = state.serviceId ? findService(state.serviceId) : null;
  if (!service) service = findService(analysis?.collected?.service ?? analysis?.raw?.message ?? '');

  const missing = [];
  if (!state.fullName) missing.push('full name');
  if (!state.email) missing.push('email address');
  if (!state.phone) missing.push('phone number');
  if (!service) missing.push('service');

  if (missing.length) {
    return {
      reply: `I can add you to the waiting list. I just need your ${missing.join(', ')}.`,
      state: { ...state, serviceId: service?.id ?? state.serviceId, stage: 'waitlist_collect' },
      suggestions: service
        ? []
        : list.slice(0, 4).map((item) => ({
            label: item.name,
            send: `Put me on the waiting list for ${item.name}`
          })),
      actions: ['waitlist_collect']
    };
  }

  const entry = addWaitlist({
    fullName: state.fullName,
    email: state.email,
    phone: state.phone,
    service,
    fromMs: Number.isFinite(state.preferredStartMs) ? state.preferredStartMs : null,
    customerId: state.customerId ?? null,
    notes: state.notes ?? null
  });

  const customer = { full_name: entry.full_name, email: entry.email, phone: entry.phone };
  try {
    const rendered = renderTemplate('waitlist-joined', { customer, service, appointment: null, tz: tz(), extra: { entry } });
    const row = enqueue({
      channel: 'email',
      recipient: entry.email,
      template: 'waitlist-joined',
      subject: rendered.subject,
      body: rendered.body,
      customerId: entry.customer_id,
      dedupeKey: `waitlist-joined:${entry.id}`
    });
    await deliverRows([row?.id], { now });
  } catch (error) {
    console.warn(`[waitlist] confirmation not sent: ${error.message}`);
  }

  return {
    reply: [
      `You're on the waiting list for ${service.name}${Number.isFinite(state.preferredStartMs) ? ` around ${formatShort(state.preferredStartMs, tz())}` : ''}.`,
      'I will email you the moment a slot opens; the first person to reply gets it.',
      'If you would rather book a later date now, just tell me a day.'
    ].join(' '),
    state: { ...state, stage: 'waitlisted', waitlistId: entry.id },
    suggestions: [
      { label: 'Check other times', send: `What times are free for ${service.name}?` },
      { label: 'Leave the waitlist', say: 'remove me from the waiting list' }
    ],
    actions: ['waitlist_joined']
  };
}

/**
 * One turn of the conversation. Every side effect (availability, booking, CRM,
 * notifications) happens here on the server, never inside the model.
 */
export async function handleMessage({
  conversationId = null,
  message,
  channel = 'web-chat',
  externalId = null,
  contact = null,
  now = Date.now()
}) {
  const text = String(message ?? '').trim();
  if (!text) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A message is required.');
  }

  const conversation = ensureConversation({ conversationId, channel, externalId, contact });
  appendMessage(conversation.id, 'user', text);

  let state = { ...conversation.stateObject };
  if (contact) state = { ...state, ...buildSeedState(contact) };

  let analysis = null;
  if (aiConfig().enabled) {
    analysis = await understandWithLLM({
      message: text,
      history: historyForModel(conversation.id),
      state,
      now
    });
  }
  const deterministic = analyseMessage({ message: text, state, now, timeZone: tz() });
  if (!analysis || !analysis.collected) {
    analysis = deterministic;
  } else {
    analysis = resolveIntent(analysis, deterministic, state);
  }

  state = mergeCollected(state, analysis.collected ?? {}, now);

  const ctx = { state, conversation, analysis, now };
  let result;
  // A short answer to the assistant's own question belongs to the flow that
  // asked it, even when the bare sentence reads like a fresh request (for
  // example "next Friday at 3pm" after "what day would you prefer instead?").
  let intent = analysis.intent;
  if (state.stage === 'reschedule_collect_time' && ['book', 'availability', 'provide_info', 'confirm'].includes(intent)) {
    intent = 'reschedule';
  }
  if (state.stage === 'cancel_identify' && ['provide_info', 'confirm', 'book'].includes(intent)) {
    intent = 'cancel';
  }
  if (state.stage === 'waitlist_collect' && ['provide_info', 'book', 'availability', 'waitlist', 'confirm'].includes(intent)) {
    intent = 'waitlist';
  }

  try {
    switch (intent) {
      case 'escalate':
        result = await escalationFlow(ctx);
        break;
      case 'out_of_scope':
        result = await outOfScopeFlow(ctx);
        break;
      case 'cancel':
        result = await cancelFlow(ctx);
        break;
      case 'reschedule':
        result = await rescheduleFlow(ctx);
        break;
      case 'availability':
        result = await availabilityFlow(ctx);
        break;
      case 'waitlist':
        result = await waitlistFlow(ctx);
        break;
      case 'greeting': {
        if (Object.keys(missingFields(state)).length === REQUIRED_FIELDS.length) {
          result = {
            reply: business().conversation.greeting,
            state: { ...state, stage: 'collecting' },
            actions: ['greeted']
          };
        } else {
          result = await bookingFlow(ctx);
        }
        break;
      }
      default:
        result = await bookingFlow(ctx);
        break;
    }
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const retryable = error.retryable;
    if (retryable) {
      const alert = staffAlert({
        subject: `Workflow dependency failure: ${error.code}`,
        detail: `${error.message}. Customer: ${state.fullName ?? 'unknown'}.`,
        channel: conversation.channel
      });
      await deliverRows([alert?.id], { now }).catch(() => {});
    }
    result = {
      reply: [
        error.userMessage,
        'Nothing has been confirmed yet.',
        retryable
          ? `I have flagged this for our team, and you can also call ${business().supportPhone}.`
          : 'Would you like to try a different day or time?'
      ].join(' '),
      state: { ...state, stage: 'error' },
      actions: ['handled_error'],
      error: { code: error.code, message: error.userMessage, retryable }
    };
  }

  const finalState = result.state ?? state;
  saveState(conversation.id, finalState);
  appendMessage(conversation.id, 'assistant', result.reply, {
    intent,
    actions: result.actions ?? [],
    error: result.error ?? null
  });

  // Keep the CRM record warm even before a booking exists (a qualified lead).
  let customerId = finalState.customerId ?? null;
  if (!customerId && (finalState.email || finalState.phone) && finalState.fullName) {
    try {
      const crm = upsertCustomer({
        fullName: finalState.fullName,
        email: finalState.email,
        phone: finalState.phone,
        source: conversation.channel,
        notes: finalState.notes ?? null
      });
      customerId = crm.customer?.id ?? null;
    } catch (error) {
      console.warn(`[crm] lead sync skipped: ${error.message}`);
    }
  }
  if (customerId) {
    run(
      'UPDATE conversations SET customer_id = ?, updated_at = ? WHERE id = ?',
      customerId,
      nowIso(),
      conversation.id
    );
    if (result.appointment && intent !== 'cancel') {
      run(
        'UPDATE appointments SET conversation_id = ? WHERE id = ?',
        conversation.id,
        result.appointment.id
      );
    }
  }

  saveConversationInsight(conversation.id, {
    summary: analysis.summary ?? `${analysis.intent} turn: ${text.slice(0, 160)}`,
    structured: {
      intent,
      stage: finalState.stage ?? null,
      confidence: analysis.confidence ?? null,
      source: analysis.source ?? 'deterministic',
      collected: {
        fullName: finalState.fullName ?? null,
        email: finalState.email ?? null,
        phone: finalState.phone ?? null,
        service: finalState.serviceId ?? null,
        preferredStart: finalState.preferredStartMs
          ? new Date(finalState.preferredStartMs).toISOString()
          : null,
        notes: finalState.notes ?? null,
        reference: finalState.lastAppointmentRef ?? finalState.reference ?? null
      },
      outcome: result.actions ?? []
    }
  });

  run(
    "UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?",
    ['cancelled', 'booked', 'handoff', 'escalated'].includes(finalState.stage) ? 'resolved' : 'open',
    nowIso(),
    conversation.id
  );

  audit('conversation.turn', {
    actor: `agent:${conversation.channel}`,
    entity: 'conversation',
    entityId: conversation.id,
    detail: { intent, actions: result.actions ?? [], error: result.error?.code ?? null }
  });

  return {
    conversationId: conversation.id,
    channel: conversation.channel,
    reply: result.reply,
    intent,
    stage: finalState.stage ?? 'collecting',
    state: publicState(finalState),
    appointment: result.appointment ?? null,
    suggestions: result.suggestions ?? [],
    actions: result.actions ?? [],
    error: result.error ?? null,
    assistant: {
      source: analysis.source ?? 'deterministic',
      provider: analysis.provider ?? null,
      confidence: analysis.confidence ?? null,
      model: analysis.model ?? null
    }
  };
}
