/**
 * Reconciliation between this diary and the client's existing system.
 *
 *   node scripts/reconcile.js --days 30           report only
 *   node scripts/reconcile.js --days 30 --heal    cancel bookings the other
 *                                                 system no longer has
 *
 * The client's endpoint contract (point RECONCILE_URL at it, defaults to
 * <BRIDGE_WEBHOOK_URL>/appointments):
 *
 *   GET {RECONCILE_URL}?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   -> { "appointments": [ { "reference": "BS-2026-ABC12", "status": "confirmed", "start": "..." } ] }
 *
 * Exit code 0 when the two systems agree, 1 when drift was found, 2 on error.
 */
import { compareAppointments } from '../src/lib/bridge.js';
import { cancelAppointment, listAppointments } from '../src/lib/appointments.js';
import { business } from '../src/lib/config.js';
import { isoDate } from '../src/lib/time.js';
import { closeDatabase } from '../src/lib/db.js';

const args = process.argv.slice(2);
const heal = args.includes('--heal');
const daysIndex = args.indexOf('--days');
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 30;

const bridgeUrl = (process.env.BRIDGE_WEBHOOK_URL || '').replace(/\/$/, '');
const endpoint = process.env.RECONCILE_URL || (bridgeUrl ? `${bridgeUrl}/appointments` : '');
const token = process.env.BRIDGE_WEBHOOK_TOKEN || '';

function fail(message) {
  console.error(`[reconcile] ${message}`);
  closeDatabase();
  process.exit(2);
}

if (!endpoint) {
  fail('set BRIDGE_WEBHOOK_URL (or RECONCILE_URL) to the client system endpoint');
}
if (!Number.isFinite(days) || days <= 0 || days > 365) fail('--days must be between 1 and 365');

const timezone = business().timezone;
const fromMs = Date.now();
const toMs = fromMs + days * 24 * 60 * 60 * 1000;
const from = isoDate(fromMs, timezone);
const to = isoDate(toMs, timezone);

let remote;
try {
  const response = await fetch(`${endpoint}?from=${from}&to=${to}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`endpoint responded ${response.status}`);
  remote = await response.json();
} catch (error) {
  fail(`could not read the client system: ${error.message}`);
}

const remoteList = Array.isArray(remote) ? remote : remote?.appointments;
if (!Array.isArray(remoteList)) fail('the endpoint must return { appointments: [...] }');

const local = listAppointments({ fromMs, toMs, limit: 2000 });
const report = compareAppointments(local, remoteList);

console.log(`[reconcile] ${from} -> ${to} (${timezone})`);
console.log(`  matched            ${report.matched.length}`);
console.log(`  missing remotely   ${report.missingRemotely.length}`);
console.log(`  cancelled remotely ${report.statusMismatch.length}`);
console.log(`  only remote        ${report.onlyRemotely.length}`);

for (const appointment of report.missingRemotely) {
  console.log(`  missing: ${appointment.reference} ${appointment.startLocal} ${appointment.serviceName}`);
}
for (const item of report.statusMismatch) {
  console.log(`  cancelled remotely: ${item.appointment.reference} ${item.appointment.startLocal}`);
}
for (const item of report.onlyRemotely) {
  console.log(`  only remote: ${item.reference ?? '(no reference)'} ${item.start ?? ''} ${item.status ?? ''}`);
}

if (heal && (report.missingRemotely.length || report.statusMismatch.length)) {
  const targets = [
    ...report.missingRemotely,
    ...report.statusMismatch.map((item) => item.appointment)
  ];
  for (const appointment of targets) {
    await cancelAppointment({
      reference: appointment.reference,
      reason: 'Cancelled in the client system (reconciliation)',
      actor: 'reconcile'
    });
    console.log(`  healed: cancelled ${appointment.reference} locally`);
  }
}

const drifted = report.missingRemotely.length + report.statusMismatch.length + report.onlyRemotely.length;
closeDatabase();
process.exit(drifted && !heal ? 1 : 0);
