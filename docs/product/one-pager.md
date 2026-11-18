# AI appointment booking — product one-pager

**One line:** an AI receptionist that answers enquiries, checks the real diary, books, confirms,
reminds and handles cancellations — 24/7, on the business's own website.

## The problem it removes

Small clinics, salons and studios lose bookings to voicemail, unanswered DMs and slow replies.
Staff spend hours a week on "have you got anything Tuesday?", and no-shows quietly eat the month.

## What it does

1. **Answers** every enquiry in chat, in the business's tone, on the website or embedded in an
   existing site.
2. **Qualifies** — collects name, email, phone, service and preferred time, one question at a
   time, without inventing details.
3. **Checks the real calendar** — working hours, buffers, blackout dates, notice period, and
   refuses double bookings, including two people tapping "book" at once.
4. **Books and confirms** — reference number, calendar file, confirmation email.
5. **Reminds** — 24 hours by email, 1 hour by SMS, re-armed whenever the booking moves.
6. **Handles changes** — cancel, reschedule and duplicate requests by reply, with identity checks.
7. **Tells the owner** — every booking lands in the staff dashboard and can be pushed into their
   existing system automatically.

## What the owner gets

- A staff dashboard: today/upcoming/cancelled, search, manual bookings, message status, CSV export,
  full audit trail.
- Email/SMS delivery through their own Resend and Twilio accounts, with retries.
- A bridge to their existing PMS/calendar (webhook + reconciliation), so nothing is entered twice.
- A light, installable web app (phone, tablet, desktop) for customers — no app store needed.

## What makes it different

- **Deterministic safety net:** if the AI provider is down or slow, rule-based booking still works;
  the booking flow never depends on the model.
- **Owns its availability check:** double booking is prevented at the database level, not hoped for.
- **Honest failure modes:** provider outages return a clear error and retry, instead of silently
  losing a booking.
- **Config-driven:** a new business is a 2-minute `npm run setup`, not a development project.
- **Three AI providers, no lock-in:** OpenAI, Anthropic or Gemini.

## Proof points

- 52 automated tests covering booking, double booking, cancellation, rescheduling, provider
  failure, security boundaries and email/SMS request shapes.
- 26/26 scenario checks in the demo script.
- Container image builds and runs with persistent storage; health endpoint included.
- Runs on Node 22.5+ with **no npm dependencies**.

## Commercial shape

| Offer | For | Price guide |
| --- | --- | --- |
| Done-for-you install | One business | £2,500–£4,000 setup + £299–£499/mo |
| Digital product (source licence) | Technical buyers, agencies | £199–£999 one-off |
| White-label / multi-site | Agencies, groups | £3,000–£12,000 + monthly |

Usage costs are pennies per conversation plus SMS fees, paid by the business directly.

## Demo

`npm start` → customer chat, `/admin` for staff. The demo business is configurable in
`config/business.json`; switch industry in minutes.
