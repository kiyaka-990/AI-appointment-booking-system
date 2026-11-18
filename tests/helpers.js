import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test file gets its own throwaway SQLite database. `boot()` must run
 * before the application modules are imported, because the database path is
 * read when the database is first opened.
 */
export async function boot(name) {
  const file = path.join(os.tmpdir(), `booking-${name}-${process.pid}-${Date.now()}.db`);
  process.env.DATABASE_PATH = file;
  process.env.NOTIFY_SILENT = '1';
  // Tests must not depend on whichever provider key happens to be exported in
  // the developer's shell; the AI tests set their own.
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AI_PROVIDER',
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM'
  ]) {
    delete process.env[key];
  }
  // Tests never send real email or SMS, whatever the developer's shell exports.
  process.env.NOTIFICATIONS_MODE = 'console';

  const [agent, availability, appointments, config, crm, faults, notifications, time, db] =
    await Promise.all([
      import('../src/lib/agent.js'),
      import('../src/lib/availability.js'),
      import('../src/lib/appointments.js'),
      import('../src/lib/config.js'),
      import('../src/lib/crm.js'),
      import('../src/lib/faults.js'),
      import('../src/lib/notifications.js'),
      import('../src/lib/time.js'),
      import('../src/lib/db.js')
    ]);

  db.openDatabase(file);
  process.on('exit', () => {
    // Windows keeps the handle locked until SQLite is closed, so close first.
    try {
      db.closeDatabase();
    } catch {
      // Already closed.
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${file}${suffix}`, { force: true });
      } catch {
        // A leftover temp file is harmless.
      }
    }
  });

  const tz = config.business().timezone;
  const whenText = (ms) => `${time.formatDate(ms, tz)} at ${time.formatTime(ms, tz)}`;

  function nextSlot(serviceId, afterMs = Date.now() + 3 * time.DAY_MS) {
    const service = config.findService(serviceId);
    const [slot] = availability.suggestAlternatives({
      service,
      fromMs: afterMs,
      now: Date.now(),
      timeZone: tz,
      count: 1
    });
    if (!slot) throw new Error(`No availability for ${serviceId}`);
    return { service, slot };
  }

  function makeCustomer(fullName, email, phone) {
    const { customer } = crm.upsertCustomer({ fullName, email, phone, source: 'test' });
    return customer;
  }

  /** One-shot chat booking: supplies every field, so the agent books immediately. */
  async function bookThroughChat({ fullName, email, phone, serviceId, startMs }) {
    const service = config.findService(serviceId);
    return agent.handleMessage({
      message: `I am ${fullName}, ${email}, ${phone}. I want ${service.name} on ${whenText(startMs)}`,
      channel: 'test'
    });
  }

  return {
    file,
    tz,
    whenText,
    nextSlot,
    makeCustomer,
    bookThroughChat,
    agent,
    availability,
    appointments,
    config,
    crm,
    faults,
    notifications,
    time,
    db
  };
}
