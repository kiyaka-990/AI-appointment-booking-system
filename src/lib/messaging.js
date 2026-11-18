import { notificationSettings } from './config.js';

/**
 * Outbound delivery. One provider per channel, chosen from configuration and
 * environment:
 *
 *   email: Resend (RESEND_API_KEY) -> generic webhook -> console
 *   sms:   Twilio (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM) -> webhook -> console
 *
 * `notifications.mode` in config/business.json (or NOTIFICATIONS_MODE) pins a
 * provider: auto | console | resend | twilio | webhook. Console is the safe
 * default so a fresh clone never tries to send anything.
 */
const RESEND_URL = 'https://api.resend.com/emails';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

export function messagingConfig() {
  const settings = notificationSettings();
  return {
    mode: String(process.env.NOTIFICATIONS_MODE || settings.mode || 'auto').toLowerCase(),
    fromEmail: process.env.EMAIL_FROM || settings.fromEmail || '',
    resendKey: process.env.RESEND_API_KEY || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_FROM || settings.smsFrom || '',
    webhookUrl: process.env.NOTIFICATIONS_WEBHOOK_URL || settings.webhookUrl || '',
    webhookToken: process.env.NOTIFICATIONS_WEBHOOK_TOKEN || settings.webhookToken || ''
  };
}

export function channelProvider(channel = 'email') {
  const cfg = messagingConfig();
  if (cfg.mode === 'console') return 'console';
  const emailWanted = cfg.mode === 'auto' || cfg.mode === 'resend';
  const smsWanted = cfg.mode === 'auto' || cfg.mode === 'twilio';
  if (channel === 'email' && cfg.resendKey && emailWanted) return 'resend';
  if ((channel === 'sms' || channel === 'whatsapp') && cfg.twilioSid && cfg.twilioToken && cfg.twilioFrom && smsWanted) return 'twilio';
  if (cfg.webhookUrl && (cfg.mode === 'auto' || cfg.mode === 'webhook')) return 'webhook';
  return 'console';
}

/** What /api/health and the startup banner should say. */
export function deliverySummary() {
  return {
    mode: messagingConfig().mode,
    email: channelProvider('email'),
    sms: channelProvider('sms')
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function textToHtml(text) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replaceAll('\n', '<br />')}</p>`)
    .join('');
  return `<!doctype html><html><body style="font:15px/1.55 Arial,Helvetica,sans-serif;color:#10202f">${paragraphs}</body></html>`;
}

async function readError(response) {
  try {
    const body = await response.json();
    return body?.message || body?.error?.message || body?.error || `HTTP ${response.status}`;
  } catch {
    try {
      return (await response.text()).slice(0, 200) || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}

async function sendWithResend({ to, subject, text, from }) {
  const cfg = messagingConfig();
  if (!to) throw new Error('Resend: the message has no recipient');
  const sender = from || cfg.fromEmail;
  if (!sender) throw new Error('Resend: EMAIL_FROM (or notifications.fromEmail) is required');

  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.resendKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ from: sender, to: [to], subject: subject ?? 'Your appointment', text, html: textToHtml(text) }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Resend rejected the email: ${await readError(response)}`);
  const body = await response.json().catch(() => ({}));
  return { provider: 'resend', id: body?.id ?? null };
}

async function sendWithTwilio({ to, text, channel = 'sms' }) {
  const cfg = messagingConfig();
  if (!to) throw new Error('Twilio: the message has no recipient');
  const whatsapp = channel === 'whatsapp';
  const address = (value) =>
    whatsapp && !String(value).startsWith('whatsapp:') ? `whatsapp:${value}` : value;
  const from = whatsapp
    ? address(process.env.TWILIO_WHATSAPP_FROM || cfg.twilioFrom)
    : cfg.twilioFrom;
  const params = new URLSearchParams({ To: address(to), From: from, Body: text ?? '' });
  const auth = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString('base64');

  const response = await fetch(`${TWILIO_BASE}/Accounts/${encodeURIComponent(cfg.twilioSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Twilio rejected the SMS: ${await readError(response)}`);
  const body = await response.json().catch(() => ({}));
  return { provider: 'twilio', id: body?.sid ?? null };
}

async function sendWithWebhook({ channel, to, subject, text }) {
  const cfg = messagingConfig();
  const response = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.webhookToken ? { authorization: `Bearer ${cfg.webhookToken}` } : {})
    },
    body: JSON.stringify({
      channel,
      to,
      subject,
      body: text,
      from: channel === 'email' ? cfg.fromEmail : cfg.twilioFrom
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Webhook delivery failed: ${await readError(response)}`);
  return { provider: 'webhook', id: null };
}

/**
 * Deliver one message. Returns { provider, id }; throws with a readable reason
 * so the outbox can retry and surface it on the staff dashboard.
 */
export async function deliverMessage({ channel = 'email', to, subject = null, text, from = null }) {
  const provider = channelProvider(channel);
  if (provider === 'resend') return sendWithResend({ to, subject, text, from });
  if (provider === 'twilio') return sendWithTwilio({ to, text, channel });
  if (provider === 'webhook') return sendWithWebhook({ channel, to, subject, text });
  return { provider: 'console', id: null };
}
