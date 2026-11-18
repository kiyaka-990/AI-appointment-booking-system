import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

await boot('ai');
const ai = await import('../src/lib/ai.js');

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function clearKeys() {
  for (const key of KEYS) delete process.env[key];
  delete process.env.AI_PROVIDER;
  delete process.env.OPENAI_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.GEMINI_MODEL;
}

test.beforeEach(clearKeys);
test.after(clearKeys);

test('without any key the assistant is deterministic', async () => {
  const status = ai.aiStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.provider, null);
  assert.equal(status.mode, 'deterministic-fallback');
  assert.equal(await ai.understandWithLLM({ message: 'hello' }), null);
});

test('OpenAI is detected and uses a JSON-mode chat completion', () => {
  process.env.OPENAI_API_KEY = 'sk-test-openai';
  const config = ai.aiConfig();
  assert.equal(config.provider, 'openai');
  assert.equal(config.enabled, true);
  assert.equal(config.model, 'gpt-4o-mini');

  const request = ai.buildProviderRequest(config, [
    { role: 'system', content: 'system rules' },
    { role: 'user', content: 'I need a check-up' }
  ]);
  assert.match(request.url, /\/chat\/completions$/);
  assert.equal(request.options.headers.authorization, 'Bearer sk-test-openai');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
});

test('Anthropic is detected and uses the messages API with a system field', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const config = ai.aiConfig();
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-test-model');

  const request = ai.buildProviderRequest(config, [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'Hello, how can I help?' },
    { role: 'user', content: 'Tuesday at 2pm' }
  ]);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.options.headers['x-api-key'], 'sk-ant-test');
  assert.ok(request.options.headers['anthropic-version']);

  const body = JSON.parse(request.options.body);
  assert.equal(body.system, 'rules');
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages.map((message) => message.role), ['assistant', 'user']);
});

test('Gemini is detected and uses generateContent with a JSON response type', () => {
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  const config = ai.aiConfig();
  assert.equal(config.provider, 'gemini');

  const request = ai.buildProviderRequest(config, [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Friday morning' }
  ]);
  assert.match(request.url, /:generateContent$/);
  assert.equal(request.options.headers['x-goog-api-key'], 'gemini-test-key');

  const body = JSON.parse(request.options.body);
  assert.equal(body.systemInstruction.parts[0].text, 'rules');
  assert.deepEqual(body.contents.map((entry) => entry.role), ['model', 'user']);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('AI_PROVIDER pins a provider and reports a missing key', () => {
  process.env.OPENAI_API_KEY = 'sk-test-openai';
  process.env.AI_PROVIDER = 'anthropic';
  const config = ai.aiConfig();
  assert.equal(config.enabled, false);
  assert.match(config.reason, /ANTHROPIC_API_KEY/);

  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  assert.equal(ai.aiConfig().provider, 'gemini');
});

test('a Claude reply is parsed into the structured understanding', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: '```json\n{"intent":"book","reply":"","collected":{"fullName":"Ada","service":"checkup"},"summary":"Wants a check-up","confidence":0.9}\n```'
          }
        ]
      })
    };
  };

  try {
    const result = await ai.understandWithLLM({ message: 'I am Ada, I need a check-up' });
    assert.equal(result.source, 'llm');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.intent, 'book');
    assert.equal(result.collected.fullName, 'Ada');
    assert.equal(result.summary, 'Wants a check-up');
    assert.match(captured.url, /api\.anthropic\.com/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a Gemini reply is parsed and a provider error falls back', async () => {
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  const original = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: '{"intent":"cancel","reply":"","collected":{"reference":"BS-2026-ABCDE"}}' }]
          }
        }
      ]
    })
  });
  try {
    const result = await ai.understandWithLLM({ message: 'cancel BS-2026-ABCDE' });
    assert.equal(result.intent, 'cancel');
    assert.equal(result.collected.reference, 'BS-2026-ABCDE');
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  try {
    assert.equal(await ai.understandWithLLM({ message: 'hello' }), null);
  } finally {
    globalThis.fetch = original;
  }
});
