/**
 * Seed the booking database with realistic test data covering every booking
 * status the workflow produces: confirmed appointments, a cancelled one, a
 * rescheduled one, a qualified CRM lead and the queued confirmations/reminders.
 *
 *   npm run seed
 */
process.env.NOTIFY_SILENT ??= '1'; // keep the console output readable
process.env.AI_PROVIDER ??= 'off'; // deterministic seed data

const { resetDatabase } = await import('./reset.js');
const { findService, business } = await import('../src/lib/config.js');
const { suggestAlternatives } = await import('../src/lib/availability.js');
const { createAppointment, cancelAppointment, rescheduleAppointment } = await import('../src/lib/appointments.js');
const { deliverRows } = await import('../src/lib/notifications.js');
const { upsertCustomer, findCustomerByContact } = await import('../src/lib/crm.js');
const { handleMessage } = await import('../src/lib/agent.js');
const { all } = await import('../src/lib/db.js');
const { formatDate, formatTime, MINUTE_MS } = await import('../src/lib/time.js');

const tz = business().timezone;
const now = Date.now();

function nextSlot(serviceId) {
  const service = findService(serviceId);
  const [slot] = suggestAlternatives({ service, fromMs: now + 60 * MINUTE_MS, now, timeZone: tz, count: 1 });
  if (!slot) throw new Error(`No availability for ${serviceId}. Is the business open in the next 14 days?`);
  return { service, slot };
}

async function book(customer, { serviceId, notes = null }) {
  const { service, slot } = nextSlot(serviceId);
  const result = createAppointment({
    customer,
    service,
    startMs: slot.startMs,
    notes,
    source: 'seed',
    actor: 'seed'
  });
  await deliverRows(result.deliveries);
  console.log(
    `  ${result.appointment.reference}  ${service.name.padEnd(30)} ${formatDate(slot.startMs, tz)} at ${formatTime(slot.startMs, tz)}`
  );
  return result.appointment;
}

function customer(fullName, email, phone) {
  const { customer: record } = upsertCustomer({ fullName, email, phone, source: 'seed' });
  return record;
}

console.log('\nResetting and seeding the booking database...\n');
resetDatabase();

const jane = customer('Jane Doe', 'jane.doe@example.com', '+44 7700 900123');
const amara = customer('Amara Okafor', 'amara.okafor@example.com', '+44 7700 900456');
const tom = customer('Tom Becker', 'tom.becker@example.com', '+44 7700 900789');
const priya = customer('Priya Shah', 'priya.shah@example.com', '+44 7700 900321');
const liam = customer('Liam Doyle', 'liam.doyle@example.com', '+44 7700 900654');

console.log('Confirmed appointments:');
await book(jane, { serviceId: 'checkup', notes: 'Sensitive lower left molar.' });
await book(amara, { serviceId: 'hygiene' });
await book(tom, { serviceId: 'whitening', notes: 'Wants a shade assessment before a wedding.' });

const cancelledOne = await book(priya, { serviceId: 'consultation' });
await cancelAppointment({
  reference: cancelledOne.reference,
  reason: 'Going away for work',
  actor: 'seed',
  now
});
console.log(`  -> ${cancelledOne.reference} cancelled`);

const movable = await book(liam, { serviceId: 'checkup' });
const { service: checkup } = nextSlot('checkup');
const [laterSlot] = suggestAlternatives({
  service: checkup,
  fromMs: Date.parse(movable.start) + 2 * 24 * 60 * MINUTE_MS,
  now,
  timeZone: tz,
  count: 1
});
await rescheduleAppointment({
  reference: movable.reference,
  startMs: laterSlot.startMs,
  actor: 'seed',
  now
});
console.log(`  -> ${movable.reference} rescheduled to ${formatDate(laterSlot.startMs, tz)} at ${formatTime(laterSlot.startMs, tz)}`);

// A qualified lead: details collected and written to the CRM, no booking yet.
const lead = await handleMessage({
  message: 'Hi, I am interested in smile design but I want to know more before booking.',
  channel: 'web-chat',
  contact: { fullName: 'Sofia Ricci', email: 'sofia.ricci@example.com', phone: '+44 7700 900987' }
});
console.log(`\nQualified lead: Sofia Ricci (${lead.stage}) - CRM record written.`);

const counts = {
  customers: all('SELECT COUNT(*) AS c FROM customers')[0].c,
  appointments: all('SELECT COUNT(*) AS c FROM appointments')[0].c,
  notifications: all('SELECT COUNT(*) AS c FROM outbox')[0].c,
  conversations: all('SELECT COUNT(*) AS c FROM conversations')[0].c
};

console.log('\nSeed complete:');
console.log(`  customers      ${counts.customers}`);
console.log(`  appointments   ${counts.appointments}`);
console.log(`  notifications  ${counts.notifications} (confirmations + queued reminders)`);
console.log(`  conversations  ${counts.conversations}`);
console.log(`\nDatabase: ${process.env.DATABASE_PATH || 'data/booking.db'}`);
console.log('Run `npm start` and open http://127.0.0.1:3000 to talk to the assistant.\n');
console.log(`Seeded contact for the demo: ${findCustomerByContact({ email: 'jane.doe@example.com' })?.full_name}`);
