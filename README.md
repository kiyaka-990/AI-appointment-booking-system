# AI Appointment Booking System

A complete, reusable appointment-booking automation for a service business. A customer makes an
enquiry by web chat or webhook; an AI assistant qualifies it, collects the required details, checks
real availability, books a slot, writes the CRM record, sends a confirmation and schedules
24-hour and 1-hour reminders. Cancellation, rescheduling, duplicate protection and dependency
failures are handled explicitly.

```
Customer Enquiry -> AI Assistant -> Information Collection -> Availability Check
      -> Booking -> CRM Update -> Confirmation -> Reminder
```

The bundled example business is a dental clinic (Bright Smile Dental Clinic, Europe/London), but
everything business-specific lives in `config/business.json`, so the same workflow can be re-pointed
at healthcare, real estate, consulting, beauty, education or professional services without touching
the engine.

---

## Quick start

Requirements: Node.js **22.5+** (uses the built-in `node:sqlite` module). No npm dependencies.

```bash
npm run setup      # guided installer: writes config/business.json and .env for a new business
npm start          # web chat at /, staff dashboard at /admin, REST API on http://127.0.0.1:3000
npm run seed       # realistic test data (confirmed/cancelled/rescheduled bookings, reminders, a lead)
npm run demo       # runs the 7 required scenarios end-to-end and asserts the outcomes
npm test           # automated test suite (68 tests)
npm run reset      # wipe the database and recreate the schema
npm run backup     # consistent SQLite snapshot in data/backups
npm run reconcile  # compare the diary with the client's existing system
```

`npm run setup` is the productised path: it asks for the business details, services, staff login and
provider keys, then writes a fresh config and a `.env` with generated secrets. `--yes` plus flags
runs it non-interactively for provisioning a client directory (`npm run setup -- --dir=clients/name ...`).

The staff dashboard defaults to `staff` / `brightsmile` when `STAFF_PASSWORD` is unset (the startup
banner says so loudly); `npm run setup` always sets a real password.

Stop the server before running `npm run seed` or `npm run reset`: they replace the SQLite files,
and Windows will not let a live process replace an open database.

`npm start` serves the chat widget at `/` and the API under `/api`. Without an `OPENAI_API_KEY` the
assistant runs in deterministic (rule-based) mode; with a key it uses the LLM for understanding and
still keeps every side effect on the server.

Copy `.env.example` to `.env` to configure the key and other settings (`node --env-file` semantics
are built into the server via `process.loadEnvFile`).

---

## Selling it

This repository is packaged to be sold three ways: done-for-you installation, a source-licence
digital product, and a managed instance per client. The commercial material lives in `docs/product`:

- `one-pager.md` - what a buyer reads first.
- `pricing.md` - tiers, add-ons and the ROI line that closes deals.
- `sales-playbook.md` - who to target, discovery questions, demo script, objections, pilot.
- `proposal-template.md` - fill-in proposal with scope, timeline and price.
- `install-guide.md` - the buyer's installation and go-live checklist.
- `../LICENSE.md` - Standard (one business) and Extended/white-label licence terms.

Structural rule: one deployment per business. A shared multi-tenant SaaS (tenant-scoped database,
users, Stripe billing) is a separate build; nothing here pretends otherwise.

---

## How the workflow is implemented

| Step | Where | What happens |
| --- | --- | --- |
| Customer enquiry | `POST /api/chat`, `POST /api/enquiries` (webhook), chat UI | Creates or resumes a conversation; webhook enquiries are de-duplicated by `externalId` |
| AI assistant | `src/lib/ai.js` + `prompts/system.md` | LLM returns structured JSON (`intent`, `collected`, `summary`, `confidence`). Falls back to `src/lib/nlu.js` on any provider error or when no key is set |
| Information collection | `src/lib/agent.js` (`bookingFlow`) | Tracks `fullName`, `email`, `phone`, `serviceId`, `preferredStartMs` in conversation state and asks for the first missing item |
| AI qualification | `ai.js` / `nlu.js` | Maps free text onto a configured service, detects intent, urgency, out-of-scope requests and readiness to book |
| Availability check | `src/lib/availability.js` | Working hours, slot interval, buffers, notice window, blackout dates and existing appointments. Suggests the nearest alternatives |
| Booking | `src/lib/appointments.js` | Re-verifies the slot inside a `BEGIN IMMEDIATE` transaction, generates the reference, stores the appointment |
| CRM update | `src/lib/crm.js` | Upserts the customer (dedupe by email/phone), appends notes, stores the AI summary and structured conversation record |
| Confirmation | `src/lib/templates.js` + `src/lib/notifications.js` | Renders and delivers the confirmation, containing name, service, date, time, reference, location and instructions |
| Reminders | same | 24 hours (email) and 1 hour (SMS) before the appointment, queued in the outbox |
| Cancellation / rescheduling | `src/lib/agent.js`, `src/lib/appointments.js` | Verifies the caller against the booking's contact details, updates the appointment, cancels stale reminders and re-arms new ones |
| Error handling | `src/lib/errors.js`, `src/lib/faults.js` | Typed failures with customer-safe messages; nothing is ever confirmed unless it was actually written |

### Code map

```
config/business.json     business, services, calendar rules, reminders, policies
prompts/system.md        AI system prompt (structured JSON contract)
src/server.js            HTTP server: chat UI, REST API, webhook, fault switches
src/lib/agent.js         conversation orchestration + flows (book/cancel/reschedule/escalate)
src/lib/ai.js            OpenAI-compatible structured extraction with fallback
src/lib/nlu.js           deterministic intent/entity extraction (no-key mode + safety net)
src/lib/availability.js  working hours, slot generation, conflict checks, alternatives
src/lib/appointments.js  create/cancel/reschedule with transaction-level double-booking protection
src/lib/crm.js           customer records, notes, conversation insight
src/lib/notifications.js outbox, delivery attempts, backoff, reminder worker
src/lib/webhooks.js      inbound webhook de-duplication: provider retries replay the stored reply
src/lib/templates.js     confirmation, reminder, reschedule, cancellation, staff alert copy
src/lib/db.js            SQLite schema and serialised write transactions
src/lib/faults.js        fault injection used by the demo and tests
public/index.html        customer-facing chat widget
scripts/                 seed, reset, demo
tests/                   node:test suite
```

---

## Configuration

Everything business-specific is in `config/business.json`:

- **business** - name, timezone, locale, currency, location, booking instructions, support contacts,
  out-of-scope and escalation copy, and the wording of each clarifying question.
- **calendar** - slot interval, buffer before/after, minimum notice, maximum advance days, weekly
  working hours (multiple windows per day supported) and blackout dates.
- **services** - id, name, aliases (how the AI recognises it), duration, price, description, optional
  intake fields and a per-service confirmation note.
- **reminders** - any number of reminder rules, each with `minutesBefore`, channel and template.
- **policies** - cancellation notice, maximum active bookings per customer, duplicate window.
- **notifications** - `console` (default, prints deliveries), or `webhook` with a URL and token.

To reuse for another industry, copy the file, change the business block and services, and point
`CONFIG_PATH` at it. The calendar rules and policies carry over unchanged.

---

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login`, `/api/auth/logout` | Staff sign-in / sign-out (session cookie) |
| GET | `/api/auth/session` | Current session |
| GET | `/api/health` | Service, database and assistant status |
| GET | `/api/config` | Public business configuration (no secrets) |
| GET | `/api/services` | Services, durations and prices |
| GET | `/api/availability?service=checkup&from=YYYY-MM-DD&days=7` | Availability grouped by day |
| POST | `/api/availability/check` | Check one exact slot (`service`, `start`) and get alternatives |
| POST | `/api/chat` | One conversation turn (`conversationId`, `message`) |
| GET | `/api/events?conversationId=...` | Live booking updates for one chat (server-sent events) |
| GET | `/api/events?scope=staff` | Live booking updates for the dashboard (staff session, server-sent events) |
| POST | `/api/enquiries` | Inbound enquiry webhook (optional `x-webhook-token`) |
| GET | `/api/conversations/:id` | Conversation, messages and the stored AI summary |
| POST | `/api/bookings` | Direct booking (`name`, `email`, `phone`, `service`, `start`, optional `idempotencyKey`) |
| GET | `/api/appointments?status=&from=&to=` | Appointment list |
| GET | `/api/appointments/:reference` | Appointment, customer, event history and notifications |
| POST | `/api/appointments/:reference/cancel` | Cancel (`reason`) |
| POST | `/api/appointments/:reference/reschedule` | Reschedule (`start`) |
| GET | `/api/customers`, `/api/customers/:id` | CRM list and customer timeline |
| GET | `/api/notifications?status=pending` | Outbox (confirmations and reminders) |
| POST | `/api/notifications/process` | Reminder worker tick - call from cron every minute |
| GET/POST/DELETE | `/api/faults` | Inspect, inject and clear dependency failures (demo tool) |
| GET | `/api/audit` | Recent audit log entries |
| GET | `/api/appointments/export.csv` | Diary export |
| GET | `/api/admin/slots?service=&date=` | Open times for one service and day (staff) |
| POST | `/api/admin/bookings` | Manual booking for phone/walk-in customers (staff) |
| POST | `/api/notifications/:id/retry` | Retry one delivery |
| GET | `/api/waitlist?status=waiting` | Customers waiting for a cancellation (staff) |
| DELETE | `/api/waitlist/:id` | Remove a customer from the waiting list (staff) |

Routes marked *(staff)* need the session cookie or `x-api-key`; the rest are public.

`start` accepts ISO 8601 (`2026-11-24T14:00:00Z`), epoch milliseconds, or natural language
(`next Friday at 3pm`) resolved in the business timezone.

Example:

```bash
curl -s localhost:3000/api/availability?service=checkup&days=3
curl -s -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"Hi, I need a check-up next Tuesday at 10am"}'
```

---

## AI assistant

`prompts/system.md` is the system prompt. It is filled with the live business name, timezone,
services and opening hours, and it instructs the model to return **JSON only**:

```json
{
  "intent": "provide_info | availability | book | confirm | cancel | reschedule | out_of_scope | escalate | greeting",
  "reply": "what to say this turn",
  "collected": {
    "fullName": null, "email": null, "phone": null, "service": null,
    "preferredDate": null, "preferredTime": null, "preferredDateText": null,
    "notes": null, "reference": null
  },
  "summary": "one sentence for the CRM record",
  "confidence": 0.0
}
```

The model never sees availability, never generates references and never confirms a booking: the
server does all of that. If the provider errors, times out, or is not configured, `src/lib/nlu.js`
produces the same structure with regular expressions and natural-language date parsing, so the
workflow keeps working. The `assistant` object in the chat response reports `source` (`llm` or
`deterministic`), `provider` and `model`.

### Supported providers

Set **one** key and the provider is detected automatically; use `AI_PROVIDER` to pin one when more
than one key is present. All three return the same structured JSON, so the workflow is identical.

| Provider | Key | Model variable | Default model |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-4o-mini` |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-sonnet-4-5` |
| Google Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `GEMINI_MODEL` | `gemini-3.1-flash-lite` |

Detection order is `AI_PROVIDER` if set, otherwise OpenAI, Anthropic, Gemini. `GET /api/health`
reports the active `provider` and `model`, or the reason the assistant is in deterministic mode.
OpenAI-compatible gateways can override `OPENAI_BASE_URL`; Gemini can override `GEMINI_BASE_URL`;
`AI_TIMEOUT_MS` (or `OPENAI_TIMEOUT_MS`) controls the request timeout.

---

## Preventing double booking

Three independent layers:

1. `checkSlot()` validates the requested time against working hours, notice windows, buffers and
   current bookings before anything is written, and returns a reason code (`PAST`, `TOO_SOON`,
   `CLOSED`, `BLACKOUT`, `OUTSIDE_HOURS`, `TAKEN`).
2. `createAppointment()` re-checks availability inside the write transaction and scans for an
   overlapping appointment with `BEGIN IMMEDIATE`, which serialises writers at the SQLite level. Two
   simultaneous requests cannot both commit.
3. The schema enforces it: a unique partial index on `appointments(start_ms)` for active statuses, and
   a unique index on the idempotency key, so a retried request replays instead of duplicating. The
   duplicate and limit checks also run a second time *inside* the write transaction, so even two
   requests that both pass the advisory checks cannot both commit; a database-level uniqueness
   failure surfaces as the same friendly `SLOT_TAKEN` / replay response rather than an error.

Duplicate requests from the same customer (same slot, or the same service within the configured
window) return `DUPLICATE_BOOKING` and quote the existing reference instead of creating a second
appointment. Per-customer active bookings are capped by `policies.maxActiveBookingsPerCustomer`.

Inbound channels are covered too: every Twilio webhook event is de-duplicated by its `MessageSid`
(`src/lib/webhooks.js`), so a provider retry replays the original reply instead of running the
assistant again — a retried WhatsApp message can never double-book or send a second reply.

---

## Confirmations and reminders

Booking does not depend on email: the confirmation and both reminders are written to the `outbox`
table with `dedupe_key`s, then delivery is attempted immediately and retried with exponential backoff
(1, 5, 15, 60, 180 minutes) up to five attempts. A failed delivery is recorded on the row rather than
losing the booking. Every delivery atomically claims its row first, so overlapping worker ticks (a
cron job plus a manual "process due queue" click) can never send the same message twice, and a claim
left behind by a crashed worker is released by the next tick.

Run the worker on a schedule (cron, Cloud Scheduler, n8n schedule node, or a 60-second timer):

```bash
curl -s -X POST localhost:3000/api/notifications/process
```

Reminders are queued relative to the appointment start, so a reschedule cancels the old pending
reminders and arms new ones. Reminders whose time has already passed (for example a booking made two
hours ahead) are skipped rather than sent late.

The server runs this worker itself every minute (`SCHEDULER_ENABLED`, on by default; interval via
`SCHEDULER_INTERVAL_MS`), so a small deployment needs no external cron. Every delivery atomically
claims its outbox row first, so an external cron pointed at the same endpoint (or a second instance)
can safely overlap the built-in scheduler without double-sending.

### How the customer is notified immediately

Four channels fire from the same booking transaction, so nothing depends on the chat window staying
open:

1. **In the conversation** - the reply states the service, date, time and reference, and a booking card
   appears with copy / calendar / manage actions.
2. **Live push to the open page** - `GET /api/events?conversationId=...` is a server-sent-event stream
   fed by `src/lib/events.js`. A booking, move or cancellation made by the assistant *or by staff in the
   dashboard* arrives in under a second as a toast plus a system note; the payload carries only status,
   reference, time and service, never contact details.
3. **Email** - the confirmation (and the cancellation notice) is queued at the same moment and
   delivered on the first attempt. `notifications.mode` decides where it goes: `console` for a demo,
   `webhook` to an email/SMS provider (Resend, SendGrid, Postmark, Twilio via a small n8n/Zapier flow).
4. **Device notification** - after a booking the customer can press *Enable alerts*; with permission
   granted, `showNotification` displays the update while the app is open or minimised as an installed
   app. This is the Notification API, not a push service: for alerts when the app is fully closed,
   point `notifications.mode` at a push provider or rely on email/SMS.
5. **Staff alerts** - the dashboard keeps `GET /api/events?scope=staff` open (session-protected,
   same-origin only). A new booking, move or cancellation reaches every open dashboard in under a
   second as a toast, a chime and a refreshed list; the 30-second poll remains as a fallback. In
   parallel, `owner-booking` emails `business.supportEmail` with the full booking, and an optional
   short `owner-alert` SMS/WhatsApp goes to `OWNER_PHONE` when Twilio is configured.

Reminders (24h email, 1h SMS) complete the sequence. The outbox retries with backoff, so a provider
outage delays a message instead of losing it.

### Email via Resend, SMS via Twilio

Delivery picks a provider per channel (`src/lib/messaging.js`):

| Channel | Provider order | Keys |
| --- | --- | --- |
| Email | Resend -> webhook -> console | `RESEND_API_KEY`, `EMAIL_FROM` |
| SMS | Twilio -> webhook -> console | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |

`notifications.mode` (or `NOTIFICATIONS_MODE`) is `auto` by default: real providers when configured,
otherwise the message is logged. Pin `console` to switch sending off, or `resend`/`twilio`/`webhook` to
force one. Resend receives `from`, `to`, `subject`, and both a plain-text and an HTML body; Twilio gets a
form-encoded `To`/`From`/`Body` with basic auth. Provider errors are stored on the outbox row
(`"Resend rejected the email: ..."`) and retried, so a bounced configuration is visible on the
dashboard rather than silent. `GET /api/health` reports `delivery: { mode, email, sms }`.

Owner alerts reuse the same Twilio sender. Set `OWNER_PHONE` (or `business.ownerPhone`) and optionally
`OWNER_ALERT_CHANNEL=whatsapp`; WhatsApp also needs `TWILIO_WHATSAPP_FROM`. If no phone is set, or no
provider is configured, the SMS/WhatsApp alert is skipped entirely rather than being marked as sent.
`GET /api/health` reports `ownerAlert: { channel, configured, provider }` for a quick check.

Resend requires the sending domain to be verified, and `EMAIL_FROM` must be on it. Twilio requires an
E.164 `TWILIO_FROM` and, for UK numbers, the destination country enabled in your account.

### WhatsApp and other chat apps (inbound)

Point a Twilio WhatsApp sender at `POST /api/webhooks/twilio` and the same assistant answers there:
availability, booking, cancelling, rescheduling and the waitlist all work, and the reply is returned as
TwiML so Twilio shows it in the chat. Requirements:

- `TWILIO_AUTH_TOKEN` (used to verify `x-twilio-signature`; without it the route returns 503 rather
  than accepting unsigned messages),
- `PUBLIC_BASE_URL` when a proxy rewrites the host, so the signed URL matches the one Twilio called,
- `TWILIO_WHATSAPP_FROM` for outbound WhatsApp (e.g. `whatsapp:+14155238886`); SMS still uses
  `TWILIO_FROM`.

Each sender number maps to one conversation (`channel: 'whatsapp'`, `external_id` = phone), so the
customer never repeats themselves. Forged signatures return 403 and are never processed.

**Retries are safe.** Twilio re-posts a webhook for up to three days when a delivery is not
acknowledged in time. Every inbound event is claimed by `MessageSid` before the workflow runs and the
reply is stored with it (`webhook_events` table): the first delivery answers the customer, and a
retry gets the stored TwiML back with no side effects — no second reply, no duplicate CRM write, no
second booking attempt. A claim left behind by a crashed worker is taken over by the next retry, and
a failed turn releases the claim so the retry is processed rather than replayed. Stale events are
pruned after seven days.

---

## Owner / staff side

The business owner does not need to read the database. They sign in at `/admin` and get:

- **Today, upcoming and cancelled appointments** with customer name, email, phone, notes and the
  reference, plus search across name, email, phone and reference.
- **Booking detail**: full history (booked / moved / cancelled), the status of every confirmation and
  reminder, and one-click **cancel** (the reason is sent to the customer).
- **Reschedule with a real slot picker** - pick a date, see the open times for that service, move the
  booking. Reminders are re-armed and the customer is emailed.
- **Manual booking** for phone and walk-in customers: choose a service, date and open time, enter the
  contact details, and the same confirmation/reminder/CRM pipeline runs.
- **Customers** tab with each customer's appointments and conversations, and **Messages** tab showing
  the confirmation/reminder queue with retry and "process due queue".
- **Waitlist** tab showing who is waiting for a slot, for which service and window, whether they were
  already offered a cancellation, and a **Remove** action.
- **CSV export** of the diary (`/api/appointments/export.csv`) for payroll, reporting or a spreadsheet.
- **An email for every new booking** (`owner-booking` in the outbox, sent to `business.supportEmail`)
  with the reference, customer contact, service, date, time and notes. The same outbox delivers the
  customer confirmation and both reminders, so one provider integration covers staff and customers.
- **Staff alerts** for escalations, out-of-scope requests and dependency failures.

Sign in with `STAFF_USER` / `STAFF_PASSWORD` (demo fallback: `staff` / `brightsmile`, warned at
startup). Set `business.supportEmail` to the owner's inbox. Outbound delivery is console output until
`notifications.mode` is set to `webhook` (see below), so for a live business point that at an email or
SMS provider.

## Security

- **Staff authentication**: signed, HttpOnly, SameSite=Strict session cookies (8 hours), scrypt
  password comparison with timing-safe checks, and a per-IP limit of 8 failed sign-ins per 10 minutes.
  Without `STAFF_PASSWORD` the dashboard falls back to a demo password and says so loudly at startup.
- **Route separation**: chat, availability and configuration are public; appointments, customers,
  conversations, notifications, audit, faults and all staff actions require a session or an
  `x-api-key` (when `API_KEY` is set).
- **Conversation identity is server-to-server only**: the public chat endpoint ignores
  caller-supplied `channel`/`externalId`/`contact` unless the request carries the API key, so a
  browser cannot claim another customer's identity (their WhatsApp number) to read their conversation
  state or change their bookings. WhatsApp threads can only be addressed by signed Twilio inbound
  events; the enquiry webhook rejects the `whatsapp` channel outright.
- **Webhook replay protection**: inbound Twilio events are de-duplicated by `MessageSid` and the
  original reply is stored, so a provider retry replays instead of re-running the assistant.
- **CSRF**: cookie-authenticated writes must come from the same origin; cross-site origins get 403.
- **Headers and CSP**: strict `default-src 'self'` policy (no inline script or style), `nosniff`,
  `frame-ancestors 'none'`, `no-referrer`, and `no-store` on API responses. In production, HSTS is
  sent and every response carries an `x-request-id` that matches its log line for support.
- **Input handling**: JSON body size limits, validated/typed errors, output rendered with `textContent`
  in the UI (no HTML injection from customer input), path traversal checks on static files, and
  parameterised SQL throughout.
- **Safe exports**: the diary CSV neutralises customer text that begins with a spreadsheet-significant
  character (`=`, `+`, `-`, `@`), so Excel or Google Sheets cannot execute it as a formula when staff
  open the export.
- **Webhooks**: optional `x-webhook-token` for `/api/enquiries`; set `WEBHOOK_TOKEN` in production.
- **Audit trail**: sign-ins, failures, cancellations, reschedules and staff bookings are recorded in
  `audit_log` with actor and timestamp.

## Calendar: what it books into

It does **not** talk to Calendly, Google Calendar or Outlook out of the box. The appointments table in
SQLite **is** the calendar: availability, conflicts, buffers, working hours and blackout dates are all
computed and enforced there, and the staff dashboard reads from it.

That is deliberate - the booking logic must own the availability check, otherwise two systems can
disagree and double-book. To use a real calendar, keep that contract and swap the storage in one place:

1. `busyIntervals()` in `src/lib/availability.js` returns the busy periods for a window. Back it with
   the Google Calendar/Outlook API (or a Calendly event-type availability call).
2. `createAppointment()` / `rescheduleAppointment()` in `src/lib/appointments.js` write the event to
   the external calendar inside the same guarded block, then store the external event id on the
   appointment.
3. Keep the re-check immediately before the write, and keep the owner notification, so a booking made
   in the dashboard and a booking made in Google Calendar cannot both take the same slot unnoticed.

Calendly specifically is a scheduling front-end with its own availability: if the client insists on
it, the clean split is Calendly for the customer-facing slot picker and this workflow for the AI
conversation, CRM update, confirmation, reminders and staff dashboard - synchronised by webhooks
(`invitee.created` / `invitee.canceled`) rather than by two independent writers.

## Cancellation and rescheduling

Both flows verify the booking before changing it:

- A reference is looked up and its status checked (already cancelled / not active is reported).
- The caller's email or phone must match the CRM record for that booking (`CONTACT_MISMATCH`
  otherwise) - this stops someone cancelling a booking just by knowing its reference.
- Without a reference, the booking is located by the contact details in the conversation.
- Cancelling releases the slot and cancels pending reminders.
- Rescheduling keeps the reference, moves the appointment, records `rescheduled_from`, writes an
  audit event, sends an updated confirmation and re-arms reminders. If the new time is taken, the
  original booking is left untouched and alternatives are offered.

---

## Filling cancelled slots (waitlist)

A customer who cannot find a time says so in the chat (“nothing works this week”, “let me know if
someone cancels”). The assistant collects their name, email, phone and the service, stores the
entry in the `waitlist` table, confirms by email (`waitlist-joined`) and keeps the preferred date
window when one was mentioned.

When any booking is cancelled, `offerFreedSlot()` runs inside the cancellation transaction:

- matches waiting entries for the same service (or any service when the entry has none),
- and only those whose preferred window covers the freed slot,
- offers the slot to the oldest three matches by email (`waitlist-available`), first come first
  served, and marks each `notified` so the same slot is never offered twice.

The staff dashboard API exposes the list, and `DELETE /api/waitlist/:id` removes an entry. Matching
rules live in `src/lib/waitlist.js`; no configuration is required.

---

## Error handling

| Situation | Behaviour |
| --- | --- |
| Missing information | Asks for the first missing field and records `MISSING_INFORMATION` |
| Invalid / unclear date | Asks again with an example format (`INVALID_DATETIME`) |
| No availability | Never books; offers the nearest alternatives for the next 14 days |
| Duplicate booking | Names the existing reference and offers to move or cancel it |
| Calendar read/write failure | Stops, tells the customer nothing was confirmed, alerts staff, does not guess availability |
| CRM failure | Booking is not written (customer record is created first); customer is told nothing was confirmed |
| Notification failure | Booking stands; message is retried with backoff and the failure is recorded |
| Out-of-scope request | Hands off to a human, alerts staff, does not invent an answer |
| Urgent/emergency wording | Refuses to book, gives the emergency instructions from the config, alerts staff |
| Rate limiting | `429 RATE_LIMITED` per client for chat and webhook endpoints |

Fault injection is available for demonstrations and tests:

```bash
curl -X POST localhost:3000/api/faults -H 'content-type: application/json' -d '{"calendar.read":true}'
curl -X DELETE localhost:3000/api/faults
```

Keys: `calendar.read`, `calendar.write`, `crm`, `notifications`, `ai`.

---

## Connecting a client's existing system

Two directions, both configurable per client:

**Outbound bridge (no vendor API needed).** Point `integrations.webhook.url` (or `BRIDGE_WEBHOOK_URL`) at
their endpoint and every booking, move and cancellation is POSTed as JSON, signed with
`Authorization: Bearer <token>` and `x-bridge-event`. Events are queued in `bridge_outbox` and retried
with backoff (1 min to 6 h, 8 attempts), so their system being down never loses a booking. The payload:

```json
{
  "event": "appointment.created",
  "sentAt": "2026-11-16T10:00:00.000Z",
  "business": { "id": "bright-smile", "name": "Bright Smile Dental Clinic", "timezone": "Europe/London" },
  "appointment": {
    "reference": "BS-2026-6RSGJ", "status": "confirmed", "serviceId": "hygiene",
    "serviceName": "Hygiene & Polish", "start": "2026-11-25T10:00:00.000Z",
    "end": "2026-11-25T10:45:00.000Z", "location": "12 Market Street, London EC1A 4JQ"
  },
  "customer": { "fullName": "Jane Doe", "email": "jane@example.com", "phone": "07700900123" }
}
```

The receiving side can be an n8n/Make/Zapier flow, a Google Apps Script, a Lambda, or the client's own
PMS adapter. The worker tick (`POST /api/notifications/process`) also flushes the bridge, and
`GET /api/bridge` (staff) lists queued, sent and failed events for troubleshooting.

**Reconciliation.** `npm run reconcile -- --days 30` compares the next 30 days with an endpoint that
returns `{ "appointments": [ { "reference", "status" } ] }` (default `<bridge url>/appointments`, override
with `RECONCILE_URL`). It reports bookings missing remotely, cancelled remotely and bookings that exist
only remotely. Add `--heal` to cancel locally the ones their system no longer has; run it from cron
every 10-15 minutes in a two-way integration.

**Inbound.** Their website, phone system or CRM can drive the same assistant through `POST /api/chat`,
`POST /api/enquiries` or `POST /api/bookings` with `x-api-key` - no per-vendor work required.

**Embedding on their website.** `public/embed.js` turns a `<div>` into the widget:

```html
<div id="booking-widget"></div>
<script src="https://booking.theirclinic.com/embed.js" data-height="700" defer></script>
```

The app refuses to be framed until you list their origin in `EMBED_ORIGINS`
(`https://theirclinic.com,https://www.theirclinic.com`); with that set, `frame-ancestors` allows only
those origins and `X-Frame-Options` is dropped. `?embed=1` hides the marketing panels and reports its
height back to the parent page.

For a client whose PMS owns the calendar (Dentally, Cliniko, Fresha, Calendly), keep that system as the
source of truth and implement the two adapter points in `README` -> *Calendar: what it books into*;
the bridge then keeps their side informed.

---

## Deploying it

Any host that runs a container or Node 22.5+ works; storage is a single SQLite file that must live on a
persistent disk.

| Target | Command | Notes |
| --- | --- | --- |
| Docker | `docker compose up -d --build` | `.env` is read by compose, data in the `booking-data` volume |
| Render | Blueprint from `render.yaml` | 1 GB disk mounted at `/var/data`, secrets prompted on first deploy |
| Fly.io | `fly launch --copy-config`, create the `booking_data` volume, set secrets | One always-on 512 MB machine |
| VPS | `docker build -t booking . && docker run -d --env-file .env -v booking-data:/data -p 3000:3000 booking` | Put Caddy/nginx in front for TLS |

Before going live: set `STAFF_PASSWORD`, `SESSION_SECRET` (otherwise sessions end on restart),
`API_KEY`, `EMAIL_FROM` on a verified Resend domain, and `TWILIO_FROM`. Reminders, retries and the
bridge are handled by the built-in scheduler; point your own cron at
`POST /api/notifications/process` only if you disable it (`SCHEDULER_ENABLED=0`). Behind a reverse
proxy, set `PUBLIC_BASE_URL` (for signed Twilio webhooks) and `TRUST_PROXY=1` (so rate limits key on
the real client IP - the Fly proxy's `Fly-Client-IP` and `X-Forwarded-For` are both honoured), and
`NODE_ENV=production` for Secure cookies and HSTS.

Note that serverless platforms (Vercel functions, AWS Lambda) are not a fit: the app needs a
writable SQLite file, long-lived SSE streams and the in-process scheduler, none of which serverless
functions provide. Deploy it as a always-on container (Docker, Fly, Render, Railway, a VPS).

Backups: `npm run backup` writes a consistent `VACUUM INTO` snapshot to `data/backups` and keeps the
last 14 (`BACKUP_KEEP`, `BACKUP_DIR`). On a host, run it nightly and copy the files off the machine.

Health: `GET /api/health` returns service, database, assistant and delivery status - use it as the
load-balancer or platform health check. It never includes secrets.

### What is not multi-tenant

This is one deployment per business. A shared SaaS needs a `business_id`-scoped database (or one
SQLite file per tenant), a users table instead of a single staff password, Stripe billing with plan
limits, and per-tenant configuration edited in the UI instead of `config/business.json`. That is a
separate build, not a config flag - the honest estimate from the pricing notes is 6-10 weeks.

---

## Installing it as an app (PWA)

The customer chat and the staff dashboard are installable on Android, iPhone/iPad, Windows, macOS and
Chromebooks - no app store, no build step:

- **Android / Chrome / Edge / Windows / macOS Chrome**: open the chat and press **Install** in the header
  (or the install icon in the address bar). It opens in its own window, offline shell included.
- **iPhone / iPad (Safari)**: Share -> **Add to Home Screen**; it launches full screen with the app icon.
- **macOS Safari 17+**: File -> **Add to Dock**.

What makes it installable: `GET /manifest.webmanifest` (generated from `config/business.json`, so the
name, colour and icons follow the client's brand), 192/512 px icons plus a maskable icon, an
`apple-touch-icon`, and `public/sw.js`, which caches the shell for offline use and always goes to the
network first for app code and `/api` responses.

Regenerate the icons for a new brand with `npm run icons` after editing the palette in
`scripts/make-icons.js`.

It is a PWA, not a store app: there is no App Store / Play Store listing, no native push entitlement and
no access to native contacts or the camera. If a client needs a store listing, the same server can be
wrapped with Capacitor without changing the API.

---

## Test data and scenarios

`npm run seed` creates five customers with confirmed, cancelled and rescheduled appointments, their
confirmations and queued reminders, plus one qualified lead (details in the CRM, no booking).

`npm run demo` runs the required scenarios against a separate `data/demo.db` and asserts each result.
Both scripts force the deterministic assistant (`AI_PROVIDER=off`) so results are reproducible; set
`AI_PROVIDER` yourself to run them against a live model.

1. Customer successfully books an available appointment.
2. Requested time is unavailable and the system suggests alternatives.
3. Customer attempts to create a duplicate booking.
4. Customer cancels an appointment.
5. Customer reschedules an appointment.
6. Required customer information is missing.
7. Calendar/API failure occurs (and the system recovers afterwards).

`npm test` covers those scenarios plus simultaneous double submits, idempotency replay, Twilio
webhook retries (replayed with no side effects, never reprocessed), outbox race protection, contact
verification on cancellation, CRM/notification/write failures, the AI fallback, and the security
boundary: protected routes, signed sessions, forged cookies, CSRF, conversation identity spoofing,
security headers, staff manual bookings, CSV export, delivery retry and API-key access.

---

## Database

SQLite (`node:sqlite`), WAL mode, foreign keys on. Tables:

- `customers` - CRM record: name, email, phone, source, notes, tags.
- `conversations` - channel, status, conversation state, AI summary and structured extraction.
- `messages` - full transcript with intent/action metadata.
- `appointments` - reference, customer, service, start/end (epoch ms + business-local date), status,
  location, notes, reschedule/cancellation details, idempotency key.
- `appointment_events` - created / rescheduled / cancelled audit chain per appointment.
- `outbox` - confirmations and reminders with schedule, attempts, dedupe key and last error.
- `webhook_events` - inbound webhook claims (provider + event id), used to replay provider retries.
- `bridge_outbox` - signed appointment events queued for the client's own system.
- `waitlist` - customers waiting for a cancellation.
- `audit_log` - workflow-level audit trail.
- `rate_limits` - reserved for a persistent limiter.

`DATABASE_PATH` overrides the file location (default `data/booking.db`). Because access goes through
`src/lib/db.js`, swapping SQLite for Postgres means replacing that module and the two partial indexes.

---

## Adapting the integrations

- **Calendar:** the appointments table is the calendar. To use Google Calendar, implement
  `busyIntervals()` and the appointment write in `availability.js`/`appointments.js` against the
  Calendar API, keeping the same "check, then write, then re-check" contract.
- **CRM:** `src/lib/crm.js` is the adapter boundary (Airtable, HubSpot, GoHighLevel, Zoho). Keep the
  upsert-before-booking order so a CRM outage cannot produce an orphan booking.
- **Messaging:** `POST /api/chat` is channel-agnostic (`channel`, `externalId`, `contact`); a WhatsApp
  or email inbound webhook can map onto it directly. Outbound delivery is chosen by
  `notifications.mode` (`console` or `webhook`), so an email/SMS provider can be plugged in behind the
  webhook without touching the workflow.

---

## Answers to the proposal questions

**1. Which automation platform would you use and why?**
For a fixed-price, 3-5 day build I would use n8n self-hosted or Make, because the client can see and
edit the workflow. This repository is the engine such a platform would call: the AI, availability,
booking, CRM, notification and error handling are implemented and tested in code, so the same logic is
not re-created as untestable visual branches. The REST API fits a no-code platform's HTTP nodes (or a
webhook trigger plus "HTTP request" steps), and it also runs standalone.

**2. How would you prevent double-booking?**
Check availability before offering a time, re-check it inside the write transaction, and back that up
with a database constraint (unique index on active start times). Any conflict returns `SLOT_TAKEN` and
nothing is written. Idempotency keys make client retries safe. Details above.

**3. How would you structure the AI's output?**
Strict JSON with fixed keys (`intent`, `collected`, `summary`, `confidence`), schema-constrained with
`response_format: json_object`, validated and coerced server-side. The model only extracts and
classifies; the server owns availability, booking and confirmation. Missing or malformed output falls
back to the deterministic parser instead of failing the conversation.

**4. How would you handle API failures?**
Every dependency has a typed error and a retry policy. Calendar and CRM failures abort the booking
before writing anything, tell the customer nothing was confirmed, and alert staff. Notification
failures never lose a booking; they retry with backoff. Failures are injectable (`/api/faults`) so the
behaviour is demonstrated, not just claimed.

**5. How would you design the cancellation/rescheduling process?**
Identify the booking by reference or by contact details, verify the caller's email/phone against the
stored record, check the booking is still active, then apply the change in a transaction. Cancelling
frees the slot and cancels pending reminders; rescheduling re-checks the new slot, keeps the reference,
audits the move and re-arms reminders. Every outcome is explicit: not found, already cancelled,
contact mismatch, slot taken.

**6. How would you make it reusable for different businesses?**
All business specifics are configuration: business details, services and their aliases, working
hours, slot length, buffers, notice windows, blackout dates, reminder rules, policies and message copy.
The engine, API and conversational flows are unchanged; a new vertical means a new config file. The
calendar, CRM and messaging integrations sit behind adapters, so they can be swapped per client.

---

## Limitations

- SQLite is the calendar and CRM store. It is production-ready for a single business on one host
  (WAL, serialised writes); multi-tenant or multi-region deployments need Postgres and a shared queue.
- Outbound delivery is console output until `RESEND_API_KEY` / `TWILIO_*` are set; `auto` mode then
  sends for real. Email deliverability still depends on the verified sending domain and its DNS records.
- The deterministic assistant handles common phrasing but not open-ended conversation; set an
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` for production-quality understanding.
- The chat UI is a demonstration client; it stores one conversation id per browser session.
- The interface is light-only (`color-scheme: light`): the OS dark-mode preference is deliberately
  ignored, and the phone layout keeps the chat to one screen with the composer above the safe area.
- The installed app receives device notifications only while a page (or installed window) is running.
  Alerts to a fully closed app need a push service, and email/SMS remains the reliable channel.
