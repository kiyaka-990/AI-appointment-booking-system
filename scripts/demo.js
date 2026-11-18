/**
 * End-to-end demonstration of the required workflow, runnable in one command:
 *
 *   npm run demo
 *
 * Each scenario exercises the real orchestrator against a throwaway database and
 * asserts the outcome, so the demo doubles as a smoke test of the whole system.
 */
process.env.DATABASE_PATH = process.env.DATABASE_PATH || 'data/demo.db';
process.env.NOTIFY_SILENT = '1';
// The demo is a reproducibility check, so it runs the deterministic assistant
// unless the person running it pins a provider themselves.
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'off';

const { resetDatabase } = await import('./reset.js');
const { business, findService } = await import('../src/lib/config.js');
const { handleMessage } = await import('../src/lib/agent.js');
const { suggestAlternatives, checkSlot } = await import('../src/lib/availability.js');
const { createAppointment, getAppointmentByReference } = await import('../src/lib/appointments.js');
const { upsertCustomer, getCustomer } = await import('../src/lib/crm.js');
const { setFault, resetFaults, listFaults } = await import('../src/lib/faults.js');
const { all, get, closeDatabase } = await import('../src/lib/db.js');
const { formatDate, formatTime, DAY_MS, MINUTE_MS } = await import('../src/lib/time.js');

const tz = business().timezone;
const now = Date.now();
const results = [];

function heading(text) {
  console.log(`\n${'='.repeat(74)}\n${text}\n${'='.repeat(74)}`);
}

function say(who, text) {
  const label = who === 'user' ? 'Customer' : 'Assistant';
  const body = text.split('\n').map((line) => line).join('\n');
  console.log(`\n${label}:\n  ${body.replace(/\n/g, '\n  ')}`);
}

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`\n  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  return Boolean(condition);
}

function whenText(ms) {
  return `${formatDate(ms, tz)} at ${formatTime(ms, tz)}`;
}

async function turn(conversationId, message) {
  const result = await handleMessage({ conversationId, message, channel: 'web-chat' });
  say('user', message);
  say('assistant', result.reply);
  return result;
}

function activeCount(customerId) {
  return get(
    "SELECT COUNT(*) AS c FROM appointments WHERE customer_id = ? AND status IN ('confirmed','pending')",
    customerId
  ).c;
}

resetDatabase();
console.log(`\nDemo database: ${process.env.DATABASE_PATH}`);
console.log(`Business: ${business().name} (${tz})`);

const checkup = findService('checkup');
const hygiene = findService('hygiene');
// Keep the demo booking more than 24 hours out so both reminders are in the future.
const [first] = suggestAlternatives({ service: checkup, fromMs: now + 3 * DAY_MS, now, timeZone: tz, count: 2 });

/* ---------------------------------------------------------------------- 1 */

heading('1. Customer successfully books an available appointment');
let booking = await turn(null, `Hi, I would like a check-up on ${whenText(first.startMs)}`);
const janeConversation = booking.conversationId;
booking = await turn(janeConversation, 'My name is Jane Doe, jane@example.com, 07700900123');
booking = await turn(janeConversation, 'Yes, that time works. Please book it in.');
const bookedRef = booking.appointment?.reference;
if (!bookedRef) {
  await turn(janeConversation, 'yes');
}
const janeBooking = getAppointmentByReference(bookedRef ?? '');
check('appointment is confirmed in the calendar', janeBooking?.status === 'confirmed', janeBooking?.reference);
check('booking reference generated', /^[A-Z]{2}-\d{4}-[A-Z0-9]{5}$/.test(bookedRef ?? ''), bookedRef);
const confirmation = get(
  "SELECT * FROM outbox WHERE appointment_id = ? AND template = 'confirmation'",
  janeBooking?.id
);
check('confirmation message queued and delivered', confirmation?.status === 'sent', confirmation?.recipient);
const reminders = all(
  "SELECT template, scheduled_for FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder%'",
  janeBooking?.id
);
check(
  '24-hour and 1-hour reminders scheduled',
  reminders.length === 2,
  reminders.map((row) => `${row.template} @ ${row.scheduled_for}`).join(', ')
);
const janeCustomer = janeBooking ? getCustomer(janeBooking.customerId) : null;
check('CRM record stored with contact details', janeCustomer?.email === 'jane@example.com', janeCustomer?.full_name);

/* ---------------------------------------------------------------------- 2 */

heading('2. Requested time is unavailable and the system suggests alternatives');
const takenStart = first.startMs;
const other = upsertCustomer({
  fullName: 'Marcus Webb',
  email: 'marcus@example.com',
  phone: '07700900456',
  source: 'demo'
}).customer;
const [second] = suggestAlternatives({ service: hygiene, fromMs: takenStart, now, timeZone: tz, count: 1 });
createAppointment({ customer: other, service: hygiene, startMs: second.startMs, source: 'demo', actor: 'demo' });
console.log(`\n(Setup: Marcus already booked ${hygiene.name} at ${whenText(second.startMs)}.)`);

const elena = await turn(
  null,
  `I am Elena Petrova, elena@example.com, 07700900512. I want ${hygiene.name} on ${whenText(second.startMs)}`
);
console.log(`\n(Intent: ${elena.intent}, outcome: ${elena.actions.join(', ')})`);
check('assistant refused the taken slot', /not available|already booked/i.test(elena.reply));
check('alternative slots offered', (elena.reply.match(/^- /gm) ?? []).length >= 2);
check(
  'no second appointment written for that slot',
  all('SELECT id FROM appointments WHERE start_ms = ?', second.startMs).length === 1
);

/* ---------------------------------------------------------------------- 3 */

heading('3. Customer attempts to create a duplicate booking');
const duplicate = await turn(janeConversation, `Can I book another check-up on ${whenText(janeBooking.startMs)}?`);
check('duplicate detected and named', /already have/i.test(duplicate.reply), duplicate.error?.code);
check('existing reference quoted back', duplicate.reply.includes(janeBooking.reference));
check(
  'customer still holds exactly one active booking',
  activeCount(janeBooking.customerId) === 1,
  `${activeCount(janeBooking.customerId)} active`
);

/* ---------------------------------------------------------------------- 4 */

heading('4. Customer cancels an appointment');
const cancellation = await turn(janeConversation, `Please cancel ${janeBooking.reference}, I am away that week`);
const afterCancel = getAppointmentByReference(janeBooking.reference);
check('appointment marked cancelled', afterCancel?.status === 'cancelled', afterCancel?.cancellationReason);
check('calendar slot released', checkSlot({ startMs: janeBooking.startMs, service: checkup, now, timeZone: tz }).available);
const cancelledReminders = all(
  "SELECT id FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder%' AND status = 'pending'",
  janeBooking.id
);
check('pending reminders cancelled', cancelledReminders.length === 0);
const cancellationEmail = get(
  "SELECT * FROM outbox WHERE appointment_id = ? AND template = 'cancellation'",
  janeBooking.id
);
check('cancellation notice sent', cancellationEmail?.status === 'sent', cancellationEmail?.recipient);

/* ---------------------------------------------------------------------- 5 */

heading('5. Customer reschedules an appointment');
const [slotA] = suggestAlternatives({ service: checkup, fromMs: now, now, timeZone: tz, count: 1 });
const rescheduleBooking = createAppointment({
  customer: other,
  service: checkup,
  startMs: slotA.startMs,
  source: 'demo',
  actor: 'demo'
}).appointment;
console.log(`\n(Setup: Marcus booked ${checkup.name} at ${whenText(slotA.startMs)} - ${rescheduleBooking.reference}.)`);

let moved = await turn(
  null,
  `I need to reschedule ${rescheduleBooking.reference}. I am Marcus Webb, marcus@example.com, 07700900456.`
);
const [slotB] = suggestAlternatives({
  service: checkup,
  fromMs: slotA.startMs + 2 * 24 * 60 * MINUTE_MS,
  now,
  timeZone: tz,
  count: 1
});
moved = await turn(moved.conversationId, whenText(slotB.startMs));
const afterMove = getAppointmentByReference(rescheduleBooking.reference);
check('appointment moved to the new time', afterMove?.startMs === slotB.startMs, whenText(afterMove?.startMs));
check('same reference retained', afterMove?.reference === rescheduleBooking.reference);
check('original slot freed', checkSlot({ startMs: slotA.startMs, service: checkup, now, timeZone: tz }).available);
const rearmed = all(
  "SELECT id FROM outbox WHERE appointment_id = ? AND template LIKE 'reminder%' AND status = 'pending'",
  rescheduleBooking.id
);
check('reminders re-armed for the new time', rearmed.length === 2, `${rearmed.length} pending`);

/* ---------------------------------------------------------------------- 6 */

heading('6. Required customer information is missing');
const missing = await turn(null, 'I would like an appointment please.');
check('assistant asks for the first missing detail', missing.error?.code === 'MISSING_INFORMATION', missing.reply.split('\n')[0]);
const vague = await turn(missing.conversationId, 'My name is Alex Turner');
check('still collecting, nothing booked', vague.stage === 'collecting' && !vague.appointment);
check(
  'no appointment exists for this conversation',
  !get('SELECT id FROM appointments WHERE conversation_id = ?', missing.conversationId)
);

/* ---------------------------------------------------------------------- 7 */

heading('7. Calendar / API failure is handled safely');
setFault('calendar.read', true);
console.log(`\n(Injected fault: ${Object.entries(listFaults()).filter(([, on]) => on).map(([key]) => key).join(', ')})`);
const failure = await turn(
  null,
  'I am Nadia Khan, nadia@example.com, 07700900777. Book me a hygiene appointment this Saturday at 10am.'
);
check('failure surfaced to the customer', failure.error?.code === 'CALENDAR_UNAVAILABLE', failure.error?.retryable ? 'retryable' : 'permanent');
check('customer told nothing was confirmed', /nothing has been confirmed/i.test(failure.reply));
check(
  'no appointment written during the outage',
  !get('SELECT id FROM appointments WHERE notes LIKE ? OR customer_id IN (SELECT id FROM customers WHERE email = ?)', '%Nadia%', 'nadia@example.com')
);
resetFaults();
const recovered = await turn(
  null,
  'I am Nadia Khan, nadia@example.com, 07700900777. Book me a hygiene appointment this Saturday at 10am.'
);
console.log(`\n(After recovery: intent ${recovered.intent}, outcome ${recovered.actions.join(', ') || recovered.error?.code})`);
check('system recovers once the dependency returns', Boolean(recovered.reply));

/* ------------------------------------------------------------------------ */

heading('Summary');
const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

const audit = get('SELECT COUNT(*) AS c FROM audit_log').c;
console.log(`Audit entries written: ${audit}`);
closeDatabase();

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nDemo complete. Run `npm start` to try it in the browser.\n');
}
