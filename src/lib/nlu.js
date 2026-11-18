import { business, findService } from './config.js';
import { normaliseEmail, normalisePhone, isValidName } from './crm.js';
import { parseDateTime } from './parse-datetime.js';

const AFFIRM = /^(yes|yeah|yep|yup|sure|ok|okay|k|correct|confirm|confirmed|definitely|absolutely|do it|go ahead|go for it|that works|that's fine|thats fine|perfect|sounds good|please do|book it|yes please|please book)\b/i;
const NEGATIVE = /^(no|nope|not that|another|different|none of those|other times|not quite)\b/i;

const CANCEL_PATTERN = /\b(cancel|cancell?ation|call it off|not going to make it|can't make it|cant make it)\b/i;
const RESCHEDULE_PATTERN = /\b(reschedul\w*|re-?book|move (?:my|the|it)|change (?:my|the) appointment|change the time|another time|different time|postpone|push (?:it|my appointment))\b/i;
const AVAILABILITY_PATTERN = /\b(available|availability|free|what times|which times|any slots|slots|openings|when can|do you have (?:any )?(?:times|space|slots)|earliest)\b/i;
const BOOK_PATTERN = /\b(book|booking|reserve|schedule|appointment|see (?:a|the) (?:dentist|hygienist)|come in|visit)\b/i;
const OUT_OF_SCOPE_PATTERN = /\b(refund|invoice|receipt|insurance|claim|complaint|complain|medical advice|prescription|test results|x-?ray results|diagnos\w*|discount|quote for|job|career|cv|invoice|legal|lawsuit|solicitor)\b/i;
const WAITLIST_PATTERN = /\b(waitlist|wait list|waiting list|notify me|let me know|email me when|text me when|any cancellations|if (?:a|any) (?:slot|time|cancellation)|nothing (?:works|is available|available)|no times (?:work|suit))\b/i;
const GREETING_PATTERN = /^(hi|hello|hey|good morning|good afternoon|good evening|hiya|morning|afternoon)\b[\s!.,]*$/i;

function extractEmail(text) {
  const match = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i.exec(text);
  return match ? normaliseEmail(match[0]) : null;
}

function extractPhone(text, withoutEmail) {
  const candidates = withoutEmail.match(/(?:\+|00)?\d[\d\s().-]{7,}\d/g) ?? [];
  for (const candidate of candidates) {
    if (/\d{1,2}[:.]\d{2}/.test(candidate) && candidate.replace(/\D/g, '').length <= 4) continue;
    const phone = normalisePhone(candidate);
    if (phone) return phone;
  }
  return null;
}

function extractName(text) {
  const patterns = [
    /\bmy name is\s+([a-z][a-z'’.-]*(?:\s+[a-z][a-z'’.-]*){0,3})/i,
    /\b(?:i am|i'm|im|this is|it's|its)\s+([a-z][a-z'’.-]*(?:\s+[a-z][a-z'’.-]*){0,3})/i,
    /\bname\s*[:\-]\s*([a-z][a-z'’.-]*(?:\s+[a-z][a-z'’.-]*){0,3})/i,
    /\bcall me\s+([a-z][a-z'’.-]*(?:\s+[a-z][a-z'’.-]*){0,3})/i,
    /\b([a-z][a-z'’.-]*(?:\s+[a-z][a-z'’.-]*){1,2})\s+here\b/i
  ];
  const stopWords = new Set([
    'looking', 'interested', 'trying', 'hoping', 'available', 'free', 'sorry',
    'not', 'just', 'very', 'really', 'new', 'here', 'the', 'a', 'an', 'my',
    'booked', 'calling', 'writing', 'asking', 'requesting', 'posting'
  ]);
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const candidate = match[1]
      .replace(/\b(please|thanks|thank you)\b.*$/i, '')
      .trim()
      .replace(/\s+/g, ' ');
    const words = candidate.split(' ');
    if (words.length > 4) continue;
    if (words.some((word) => stopWords.has(word.toLowerCase()))) continue;
    if (!isValidName(candidate)) continue;
    return candidate.replace(/\b[a-z]/g, (char) => char.toUpperCase());
  }
  return null;
}

function extractReference(text) {
  const match = /\b([A-Za-z]{2,4}-\d{4}-[A-Za-z0-9]{4,8})\b/.exec(text);
  return match ? match[1].toUpperCase() : null;
}

function extractNotes(text) {
  const match = /\b(?:note|notes|also|just so you know|fyi)\s*[:\-]?\s*(.{4,200})$/i.exec(text);
  return match ? match[1].trim() : null;
}

function extractReason(text) {
  const match = /\bbecause\s+(.{3,200})$/i.exec(text) ?? /\b(?:reason|as)\s*[:\-]\s*(.{3,200})$/i.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Deterministic assistant used when no LLM is configured (and as the safety net
 * when the provider errors). Produces the same shape as the LLM extractor.
 */
export function analyseMessage({ message, state = {}, now = Date.now(), timeZone }) {
  const cfg = business();
  const tz = timeZone ?? cfg.timezone;
  const raw = String(message ?? '').trim();
  const text = raw.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();

  const email = extractEmail(text);
  const phone = extractPhone(text, email ? text.replace(email, ' ') : text);
  const fullName = extractName(text);
  const reference = extractReference(text);
  const notes = extractNotes(text);
  const service = findService(text);
  const dateTime = parseDateTime(text, { timeZone: tz, now });

  const escalation = (cfg.escalationKeywords ?? []).some((keyword) => lower.includes(keyword.toLowerCase()));
  if (escalation) {
    return {
      source: 'deterministic',
      intent: 'escalate',
      reply: cfg.escalationMessage,
      collected: { fullName, email, phone, service: null, preferredDateText: null, notes, reference },
      summary: `Urgent request flagged: ${text.slice(0, 140)}`,
      confidence: 0.95,
      reason: extractReason(text)
    };
  }

  let intent = 'provide_info';
  if (GREETING_PATTERN.test(text) && !dateTime && !service) intent = 'greeting';
  else if (WAITLIST_PATTERN.test(lower)) intent = 'waitlist';
  else if (CANCEL_PATTERN.test(lower)) intent = 'cancel';
  else if (RESCHEDULE_PATTERN.test(lower)) intent = 'reschedule';
  else if (OUT_OF_SCOPE_PATTERN.test(lower)) intent = 'out_of_scope';
  else if (AFFIRM.test(lower) && state.proposedSlotMs) intent = 'confirm';
  else if (NEGATIVE.test(lower) && state.proposedSlotMs) intent = 'availability';
  else if (dateTime && BOOK_PATTERN.test(lower)) intent = 'book';
  else if (dateTime) intent = 'book';
  else if (AVAILABILITY_PATTERN.test(lower)) intent = 'availability';
  else if (BOOK_PATTERN.test(lower)) intent = 'book';

  // A reschedule phrased as "change my appointment to Friday 3pm" also carries
  // the new time, which the orchestrator uses directly.
  if (intent === 'reschedule' && dateTime) intent = 'reschedule';

  const collected = {
    fullName,
    email,
    phone,
    service: service ? service.id : null,
    preferredStartMs: dateTime?.startMs ?? null,
    preferredHasTime: dateTime ? Boolean(dateTime.hasTime) : null,
    preferredDateText: dateTime ? text : null,
    notes,
    reference,
    reason: extractReason(text)
  };

  return {
    source: 'deterministic',
    intent,
    reply: '',
    collected,
    summary: null,
    confidence: 0.7
  };
}

export const patterns = {
  AFFIRM,
  NEGATIVE,
  CANCEL_PATTERN,
  RESCHEDULE_PATTERN,
  AVAILABILITY_PATTERN,
  BOOK_PATTERN,
  OUT_OF_SCOPE_PATTERN
};
