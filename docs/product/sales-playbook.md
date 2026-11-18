# Sales playbook

## Who to sell to first

Pick **one** vertical and stay there for the first ten clients — the demo, the copy and the
integration story all get sharper, and referrals stay inside the same world.

| Vertical | Why it works | Their calendar system |
| --- | --- | --- |
| Dental practices (2–5 chairs) | High appointment value, real no-show pain, phone-heavy | Dentally, SOE/Exact, Cliniko, Open Dental |
| Physio / chiropractic | Recurring visits, reminder-sensitive | Cliniko, Jane, Cliniko-style |
| Med-spa / aesthetics | Consultation-led, deposit questions, Instagram DMs | Fresha, Timely, Phorest |
| Salons / barbers (multi-chair) | Constant messages, after-hours demand | Fresha, Phorest, Timely |
| Studios / tutors / clinics | Solo operators, price-sensitive | Google Calendar |

Avoid first: anything with a bespoke internal booking system, hospitals, and buyers who need
insurance/claims handling — those are integration projects disguised as bookings.

## Buyer roles

- **Owner / principal** — signs. Cares about no-shows, revenue per chair and not hiring another
  receptionist.
- **Practice manager** — uses it. Cares about the day list, exceptions and not being blamed for
  double bookings.
- **Receptionist** — can kill it. Give them the "your job gets easier" story early, not the
  "AI replaces you" one.

## Outreach message (short, specific)

> Hi {name} — I build AI booking assistants for {vertical} practices. It answers website enquiries
> in seconds, books into your real diary and sends 24h/1h reminders. One clinic I built it for
> cut no-shows from 15% to 6% in two months. Want a 10-minute look at a demo with your services
> in it? No charge, no obligation.

Always attach or link a demo that uses **their** service names, not a generic chatbot.

## Discovery questions (10 minutes, in this order)

1. How do customers book today — phone, website, Instagram, walk-in?
2. What happens to a message that arrives at 9pm?
3. Roughly how many appointments a month, and what is your no-show rate?
4. What system holds the diary, and does it have an API or webhook?
5. Who confirms, and how long does that take per day?
6. What is an appointment worth to you on average?
7. Who else needs to see the diary?
8. Any rules the assistant must never break (clinical questions, pricing, emergencies)?

Question 4 decides the delivery: built-in diary, or bridge to their existing system. Price the
integration separately and say so early.

## Demo script (7 steps, 6 minutes)

1. Open the chat, ask for "a hygiene appointment next week" — show availability suggestions.
2. Give details — show the booking card with reference.
3. Show the staff dashboard with the booking already there.
4. Reply `RESCHEDULE <ref>` and show the diary move and reminders re-arm.
5. Ask a clinical question — show it refusing and escalating, not guessing.
6. Open it on a phone — show install to home screen (their customers will use this).
7. Show the confirmation email (or the outbox row if their provider is not connected yet).

Close with the ROI sum using **their** numbers from discovery.

## Objections

| Objection | Answer |
| --- | --- |
| "We already use Fresha/Cliniko/Dentally." | "Good — it stays the system of record. The assistant sits in front and pushes every booking into it through a webhook; reconciliation catches drift both ways." |
| "AI will say something wrong." | "The model only classifies and collects; availability, pricing and confirmations are deterministic code, and it escalates anything clinical or out of scope." |
| "Too expensive." | "What is one no-show worth? You have 80 a month at 15% — that's 12 empty slots. This recovers a few of them and answers after hours." |
| "We tried a chatbot, it was useless." | "Most are FAQ widgets. This one owns the calendar, refuses double bookings and sends the reminders — show me your diary and I'll prove it in one test." |
| "Data protection?" | "Their data stays in your database, your provider accounts, your host. Here is the retention and deletion story in one page." |
| "Can we just buy the code?" | "Yes — single-business licence, with installation support. Most owners prefer the managed version because of updates and monitoring." |

## Pilot offer

30 days, one location, 50% of the monthly fee, no setup discount. Success criteria written down
before it starts: bookings handled, hours saved, no-show rate, response time. Convert automatically
to full price; do not run open-ended free pilots.

## Follow-up cadence

Day 0 demo → Day 1 recap with the ROI numbers → Day 3 one useful thing (a screenshot of their
services in the demo) → Day 7 ask for the decision → Day 14 case study or a different vertical
example. Stop after five touches; keep them on a monthly "what's new" note.

## Metrics to watch in your own business

- Demos booked per week (target 5+).
- Demo → paid conversion (healthy: 25–40%).
- Setup hours per client (must fall below 6 by client five, otherwise productise harder).
- Monthly churn (target under 3%).
- Support minutes per client per month (if it climbs, the product has a gap; fix it once for all).
