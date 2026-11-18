import fs from 'node:fs';
import path from 'node:path';
import { business, getConfig } from './config.js';
import { isFaulty } from './faults.js';
import { formatDate, formatTime, isoDate, dayOfWeekKey } from './time.js';

const promptPath = path.join(process.cwd(), 'prompts', 'system.md');
let cachedPrompt = null;

const HOURS_LABEL = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
};

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini'
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-4-5'
  },
  gemini: {
    label: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-3.1-flash-lite'
  }
};

function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  cachedPrompt = fs.readFileSync(promptPath, 'utf8');
  return cachedPrompt;
}

function keyFor(provider) {
  if (provider === 'gemini') {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  }
  return process.env[PROVIDERS[provider].keyEnv] || '';
}

/**
 * Which provider is configured. `AI_PROVIDER` pins one (openai | anthropic |
 * gemini); without it the first provider that has a key wins in that order.
 */
export function activeProvider() {
  const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (['off', 'none', 'disabled', 'deterministic'].includes(requested)) {
    return { provider: null, key: '', reason: `AI disabled (AI_PROVIDER=${requested})` };
  }
  if (requested) {
    if (!PROVIDERS[requested]) {
      return { provider: null, key: '', reason: `unknown AI_PROVIDER "${requested}"` };
    }
    const key = keyFor(requested);
    if (!key) {
      return { provider: null, key: '', reason: `${PROVIDERS[requested].keyEnv} is not set` };
    }
    return { provider: requested, key, reason: null };
  }
  for (const provider of Object.keys(PROVIDERS)) {
    const key = keyFor(provider);
    if (key) return { provider, key, reason: null };
  }
  return { provider: null, key: '', reason: 'no AI provider key configured' };
}

export function aiConfig() {
  const { provider, key, reason } = activeProvider();
  const enabled = Boolean(provider) && !isFaulty('ai');
  const meta = provider ? PROVIDERS[provider] : null;
  return {
    enabled,
    provider,
    providerLabel: meta?.label ?? null,
    model: provider ? process.env[meta.modelEnv] || meta.defaultModel : null,
    apiKey: key,
    reason: provider ? null : reason,
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 20000)
  };
}

export function buildSystemPrompt(now) {
  const cfg = getConfig();
  const tz = cfg.business.timezone;
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(new Date(now));
  const services = cfg.services
    .map(
      (service) =>
        `- ${service.id}: ${service.name} (${service.durationMinutes} min${service.price ? `, ${cfg.business.currency} ${service.price}` : ''}) - ${service.description}`
    )
    .join('\n');
  const hours = Object.entries(cfg.calendar.workingHours)
    .filter(([, windows]) => windows.length)
    .map(([day, windows]) => `- ${HOURS_LABEL[day]}: ${windows.map(([from, to]) => `${from}-${to}`).join(', ')}`)
    .join('\n');

  return loadPrompt()
    .replaceAll('{{businessName}}', cfg.business.name)
    .replaceAll('{{industry}}', cfg.business.industry)
    .replaceAll('{{timezone}}', tz)
    .replaceAll('{{today}}', formatDate(now, tz))
    .replaceAll('{{weekday}}', weekday)
    .replaceAll('{{time}}', formatTime(now, tz))
    .replaceAll('{{services}}', services)
    .replaceAll('{{hours}}', hours || '- Closed');
}

const VALID_INTENTS = new Set([
  'provide_info', 'availability', 'book', 'confirm', 'cancel', 'reschedule',
  'out_of_scope', 'escalate', 'greeting'
]);

function coerceCollected(raw = {}) {
  const text = (value) => {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed && trimmed.toLowerCase() !== 'null' ? trimmed : null;
  };
  return {
    fullName: text(raw.fullName),
    email: text(raw.email),
    phone: text(raw.phone),
    service: text(raw.service),
    preferredDate: text(raw.preferredDate),
    preferredTime: text(raw.preferredTime),
    preferredDateText: text(raw.preferredDateText),
    notes: text(raw.notes),
    reference: text(raw.reference)
  };
}

function parseJsonReply(content) {
  const cleaned = String(content)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const attempt = JSON.parse(cleaned);
  if (!attempt || typeof attempt !== 'object') throw new Error('not an object');
  return attempt;
}

function splitMessages(messages) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const rest = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content
    }));
  return { system, rest };
}

/** Build the provider-specific HTTP request for one structured extraction. */
export function buildProviderRequest(config, messages) {
  const { system, rest } = splitMessages(messages);
  const authorization = { authorization: `Bearer ${config.apiKey}` };

  if (config.provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      options: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': config.anthropicVersion
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1200,
          temperature: 0.2,
          system,
          messages: rest
        })
      }
    };
  }

  if (config.provider === 'gemini') {
    const base = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    return {
      url: `${base}/models/${encodeURIComponent(config.model)}:generateContent`,
      options: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: rest.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
          })),
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        })
      }
    };
  }

  return {
    url: `${config.baseUrl}/chat/completions`,
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorization },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages
      })
    }
  };
}

/** Pull the assistant text out of each provider's response shape. */
export function extractProviderText(provider, payload) {
  if (provider === 'anthropic') {
    return (payload?.content ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
  }
  if (provider === 'gemini') {
    return (payload?.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }
  return payload?.choices?.[0]?.message?.content?.trim() ?? '';
}

/**
 * Ask the configured LLM for the structured understanding of the turn.
 * Any provider problem returns null so the deterministic assistant takes over.
 */
export async function understandWithLLM({ message, history = [], state = {}, now = Date.now() }) {
  const config = aiConfig();
  if (!config.enabled) return null;

  try {
    const messages = [
      { role: 'system', content: buildSystemPrompt(now) },
      {
        role: 'system',
        content: `Known information about this customer so far: ${JSON.stringify({
          fullName: state.fullName ?? null,
          email: state.email ?? null,
          phone: state.phone ?? null,
          service: state.serviceId ?? null,
          preferredSlot: state.preferredStartMs ? new Date(state.preferredStartMs).toISOString() : null,
          lastProposedSlot: state.proposedSlotMs ? new Date(state.proposedSlotMs).toISOString() : null,
          stage: state.stage ?? 'collecting',
          lastReference: state.lastAppointmentRef ?? null
        })}`
      },
      ...history,
      { role: 'user', content: message }
    ];

    const request = buildProviderRequest(config, messages);

    const response = await fetch(request.url, {
      ...request.options,
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(`[ai:${config.provider}] provider returned ${response.status}: ${detail.slice(0, 200)}`);
      return null;
    }

    const payload = await response.json();
    const content = extractProviderText(config.provider, payload);
    if (!content) return null;
    const parsed = parseJsonReply(content);
    return {
      source: 'llm',
      provider: config.provider,
      model: config.model,
      intent: VALID_INTENTS.has(parsed.intent) ? parsed.intent : 'provide_info',
      reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : '',
      collected: coerceCollected(parsed.collected),
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
      confidence: Number(parsed.confidence) || 0.5
    };
  } catch (error) {
    // Anything wrong here - missing prompt file, provider outage, malformed
    // reply - hands the turn to the deterministic assistant rather than
    // failing the conversation.
    console.warn(`[ai:${config.provider}] falling back to deterministic assistant: ${error.message}`);
    return null;
  }
}

export function aiStatus(now = Date.now()) {
  const config = aiConfig();
  const tz = business().timezone;
  return {
    enabled: config.enabled,
    provider: config.provider,
    providerLabel: config.providerLabel,
    model: config.enabled ? config.model : null,
    mode: config.enabled ? 'llm' : 'deterministic-fallback',
    reason: config.reason,
    today: isoDate(now, tz),
    weekday: dayOfWeekKey(now, tz)
  };
}

export const AI_PROVIDERS = Object.keys(PROVIDERS);
