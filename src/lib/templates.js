import { business, notificationSettings } from './config.js';
import { formatDate, formatTime } from './time.js';

export function formatMoney(amount, currency) {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function headerText() {
  const cfg = business();
  return `${cfg.name} · ${cfg.location}`;
}

export function renderTemplate(template, context) {
  const cfg = business();
  const { customer, service, appointment, tz, extra = {} } = context;
  const dateText = appointment ? formatDate(appointment.startMs, tz) : null;
  const timeText = appointment ? formatTime(appointment.startMs, tz) : null;
  const ref = appointment?.reference;

  switch (template) {
    case 'confirmation':
      return {
        subject: `Appointment confirmed · ${ref} · ${dateText}`,
        body: [
          `Hi ${customer.full_name},`,
          '',
          `Your appointment is confirmed. Here are the details:`,
          '',
          `  Name:        ${customer.full_name}`,
          `  Service:     ${service.name} (${service.durationMinutes} minutes)`,
          `  Date:        ${dateText}`,
          `  Time:        ${timeText}`,
          `  Reference:   ${ref}`,
          `  Where:       ${cfg.location}`,
          '',
          service.confirmationNote ?? cfg.bookingInstructions,
          '',
          `Need to change it? Reply CANCEL ${ref} or RESCHEDULE ${ref} and I will take care of it.`,
          `If something urgent comes up, call us on ${cfg.supportPhone}.`,
          '',
          headerText()
        ].join('\n')
      };

    case 'reminder-24h':
      return {
        subject: `Tomorrow: ${service.name} at ${timeText} (${ref})`,
        body: [
          `Hi ${customer.full_name},`,
          '',
          `A reminder that your ${service.name} is tomorrow, ${dateText} at ${timeText}.`,
          `Reference: ${ref}`,
          `Where: ${cfg.location}`,
          '',
          cfg.directions,
          cfg.bookingInstructions,
          '',
          `To change or cancel, reply CANCEL ${ref} or RESCHEDULE ${ref}.`,
          '',
          headerText()
        ].join('\n')
      };

    case 'reminder-1h':
      return {
        subject: `In 1 hour: ${service.name} (${ref})`,
        body: [
          `Hi ${customer.full_name}, your ${service.name} is in 1 hour at ${timeText}.`,
          `Reference ${ref} · ${cfg.location}.`,
          cfg.directions
        ].join(' ')
      };

    case 'reschedule':
      return {
        subject: `Appointment moved · ${ref} · ${dateText}`,
        body: [
          `Hi ${customer.full_name},`,
          '',
          extra.previousStartMs
            ? `Your appointment has been moved from ${formatDate(extra.previousStartMs, tz)} at ${formatTime(extra.previousStartMs, tz)} to ${dateText} at ${timeText}.`
            : `Your appointment is now ${dateText} at ${timeText}.`,
          '',
          `  Service:     ${service.name}`,
          `  Date:        ${dateText}`,
          `  Time:        ${timeText}`,
          `  Reference:   ${ref}`,
          `  Where:       ${cfg.location}`,
          '',
          cfg.bookingInstructions,
          '',
          headerText()
        ].join('\n')
      };

    case 'cancellation':
      return {
        subject: `Appointment cancelled · ${ref}`,
        body: [
          `Hi ${customer.full_name},`,
          '',
          `Your ${service.name} on ${dateText} at ${timeText} has been cancelled.`,
          `Reference: ${ref}`,
          extra.reason ? `Reason noted: ${extra.reason}` : null,
          '',
          `If that was a mistake, reply BOOK ${service.id} and I will find you a new time.`,
          '',
          headerText()
        ]
          .filter((line) => line !== null)
          .join('\n')
      };

    case 'owner-booking':
      return {
        subject: `New booking - ${ref} - ${dateText} at ${timeText}`,
        body: [
          `A new appointment was booked through ${extra.channel ?? 'the assistant'}.`,
          '',
          `  Reference:   ${ref}`,
          `  Customer:    ${customer.full_name}`,
          `  Email:       ${customer.email ?? 'not provided'}`,
          `  Phone:       ${customer.phone ?? 'not provided'}`,
          `  Service:     ${service.name} (${service.durationMinutes} minutes)`,
          `  Date:        ${dateText}`,
          `  Time:        ${timeText}`,
          `  Where:       ${cfg.location}`,
          `  Notes:       ${extra.notes ?? 'none'}`,
          '',
          `The customer has been sent a confirmation and will be reminded 24 hours and 1 hour before.`,
          `Manage or cancel this booking in the staff dashboard: /admin`,
          '',
          headerText()
        ].join('\n')
      };

    case 'waitlist-joined':
      return {
        subject: `You're on the waiting list for ${service.name}`,
        body: [
          `Hi ${customer.full_name},`,
          '',
          `You are on the waiting list for ${service.name}${extra.entry?.from_ms ? ` around ${formatDate(extra.entry.from_ms, tz)}` : ''}.`,
          'If a slot opens, I will email you straight away. Slots go to the first person who replies, so act quickly when you hear from us.',
          '',
          `To leave the waiting list, reply WAITLIST CANCEL or call ${cfg.supportPhone}.`,
          '',
          headerText()
        ].join('\n')
      };

    case 'waitlist-available':
      return {
        subject: `A ${service.name} slot has opened - ${dateText} at ${timeText}`,
        body: [
          `Hi ${customer.full_name},`,
          '',
          `A ${service.name} appointment has just become available on ${dateText} at ${timeText}.`,
          `It goes to the first person who replies. Reply with that time and I will book it for you, or call ${cfg.supportPhone}.`,
          '',
          headerText()
        ].join('\n')
      };

    case 'staff-alert':
      return {
        subject: `[Action needed] ${extra.title ?? 'Booking workflow alert'}`,
        body: [
          `Channel: ${extra.channel ?? 'system'}`,
          `Customer: ${customer?.full_name ?? 'unknown'} (${customer?.email ?? customer?.phone ?? 'no contact'})`,
          `Detail: ${extra.detail ?? ''}`,
          `Reference: ${ref ?? 'n/a'}`,
          '',
          `Escalate to a human agent.`
        ].join('\n')
      };

    default:
      return { subject: extra.subject ?? 'Notification', body: extra.body ?? '' };
  }
}

export function contactFor(customer, channel) {
  if (!customer) return null;
  if (channel === 'email') return customer.email;
  if (channel === 'sms' || channel === 'whatsapp') return customer.phone;
  return customer.email ?? customer.phone;
}
