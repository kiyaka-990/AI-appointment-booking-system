# Install guide (hand this to the buyer)

## What you need

- Node.js **22.5 or newer** (24 recommended), or Docker.
- A host with a **persistent disk** (Render, Fly.io, Railway, a VPS, or any container platform).
- Optional accounts: Resend (email), Twilio (SMS), OpenAI/Anthropic/Google (AI).
- Optional: a domain, e.g. `booking.yourclinic.com`.

No npm dependencies are installed; the database is SQLite inside the project.

## 1. Install

```bash
unzip appointment-booking.zip -d booking && cd booking
npm run setup
```

The installer asks for the business name, industry, timezone, currency, address, phone, email,
services (`Name:minutes:price`), staff username and password, and any provider keys. It writes
`config/business.json` and `.env`, generates `SESSION_SECRET` and `API_KEY`, and prints the staff
login once.

Non-interactive (useful for agencies provisioning a client):

```bash
npm run setup -- --yes --dir=clients/glow-salon \
  --name="Glow Salon" --timezone=Europe/London --email=hello@glowsalon.example \
  --services="Cut and finish:45:45,Colour consultation:30:0" \
  --staff-user=owner --staff-password="a-long-password"
```

## 2. Start and check

```bash
npm start          # http://localhost:3000  -> customer chat
                   # http://localhost:3000/admin -> staff dashboard
npm test           # 52 checks, no network required
npm run demo       # 26 end-to-end scenario checks
```

Sign in with the staff username and password from setup. If you left the password blank, it is in
`.env` and was printed once.

## 3. Connect email and SMS

1. **Resend** — create a key, verify the sending domain (add the DNS records they show), then set
   `RESEND_API_KEY` and `EMAIL_FROM` (must be on the verified domain).
2. **Twilio** — buy or connect a sender number, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_FROM` in E.164 format (`+44...`), and enable the destination country.
3. Restart. `GET /api/health` should show `delivery: { mode: "auto", email: "resend", sms: "twilio" }`.
   Make one test booking and confirm the email arrives; check spam if it does not.

Until these are set, messages are logged instead of sent — nothing breaks.

## 4. Add the AI provider (recommended)

Set one key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`, optionally pin with
`AI_PROVIDER`. Without a key the assistant still books using the rule-based fallback; quality of
free-text understanding is lower but the workflow is identical.

## 5. Put it on their website

Option A — subdomain (recommended): point `booking.theirclinic.com` at the deployment and link to it.

Option B — embed in the existing site:

```html
<div id="booking-widget"></div>
<script src="https://booking.theirclinic.com/embed.js" data-height="700" defer></script>
```

Add the site's origin to `EMBED_ORIGINS` (comma separated). Without it the browser will refuse to
frame the widget.

## 6. Connect an existing system (optional)

Outbound events (their endpoint receives booking/move/cancel JSON):

```bash
BRIDGE_WEBHOOK_URL=https://their-system.example/hooks/appointments
BRIDGE_WEBHOOK_TOKEN=shared-secret
```

Then run reconciliation from cron every 10–15 minutes:

```bash
npm run reconcile -- --days 30          # report
npm run reconcile -- --days 30 --heal   # also cancel locally what they cancelled
```

Inbound: their website form, CRM or phone system can call `POST /api/chat`, `/api/enquiries` or
`/api/bookings` with the `x-api-key` header.

## 7. Go live checklist

- [ ] `STAFF_PASSWORD` and `SESSION_SECRET` set (the demo password is refused in production reviews).
- [ ] `API_KEY` set if any machine endpoint is used.
- [ ] `EMAIL_FROM` on a verified domain; one real email received.
- [ ] One real SMS received; Twilio country enabled.
- [ ] Services, prices, hours and blackout dates match reality.
- [ ] `EMBED_ORIGINS` lists only their domains.
- [ ] HTTPS in front of the app (Caddy/nginx/platform), `HOST=0.0.0.0` in a container.
- [ ] Persistent disk mounted at the database path.
- [ ] Cron: `POST /api/notifications/process` every minute.
- [ ] Cron: `npm run backup` nightly, snapshots copied off the machine.
- [ ] `/api/health` monitored.
- [ ] Test booking, cancellation and reschedule done on the live domain.
- [ ] Owner shown the dashboard and the "reply CANCEL/RESCHEDULE" behaviour.

## 8. Hosting

| Target | How |
| --- | --- |
| Docker | `docker compose up -d --build` (data in the `booking-data` volume) |
| Render | Blueprint `render.yaml`, 1 GB disk at `/var/data` |
| Fly.io | `fly launch --copy-config`, volume `booking_data`, set secrets |
| VPS | `docker run -d --env-file .env -v booking-data:/data -p 3000:3000 appointment-booking` plus Caddy for TLS |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Login rejects the password | `.env` not loaded (start from the project folder), or the app restarted with a different `.env` |
| Sessions end on restart | `SESSION_SECRET` missing |
| `503 CALENDAR_UNAVAILABLE` | Database file is locked or the disk is read-only — check the volume mount and permissions |
| Email rows show `failed` | Resend domain not verified, or `EMAIL_FROM` on the wrong domain; the error is stored on the row |
| SMS rows show `failed` | Twilio number not in E.164, country not enabled, or trial account unverified recipient |
| Booking rejected as taken | Correct behaviour: someone booked the slot. Refresh availability |
| Widget blank inside their site | Their origin is not in `EMBED_ORIGINS` |
