/**
 * Talking to the providers, and the one rule that governs all of it.
 *
 * A canary that cannot reach the provider must never report drift. Every
 * failure in here is surfaced as a failure, never folded into the sample,
 * because a rate limit that silently shortened today's run would shift the
 * distribution and the tool would blame the model for its own network.
 *
 * Adapters are deliberately thin. They send one request, read one answer, and
 * hand back the text plus whatever the provider said about itself. Anything
 * cleverer belongs upstream where it can be tested without a network.
 */

import { captureIdentity } from '../identity.mjs';

export class ProviderError extends Error {
  constructor(message, { provider, status = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/** Status codes worth trying again. Everything else will say the same thing. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * One HTTP call with bounded retry.
 *
 * Retries only what can succeed later. A 401 retried three times is three
 * ways of being told the same thing, and the delay makes a broken key look
 * like a slow provider.
 */
async function request(url, options, { provider, retries = 3, timeoutMs = 120000 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

      if (response.ok) return { body, headers: response.headers };

      const retryable = RETRYABLE.has(response.status);
      const message = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;

      if (!retryable || attempt === retries) {
        throw new ProviderError(`${provider}: ${message}`, {
          provider, status: response.status, retryable, body,
        });
      }

      // Honour the provider's own backoff where it gives one, since guessing
      // shorter is how a rate limit becomes a ban.
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, 16000);

      lastError = new ProviderError(`${provider}: ${message}`, { provider, status: response.status, retryable: true, body });
      await new Promise((r) => setTimeout(r, wait));
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof ProviderError) {
        if (!error.retryable || attempt === retries) throw error;
        lastError = error;
        continue;
      }

      const aborted = error.name === 'AbortError';
      lastError = new ProviderError(
        `${provider}: ${aborted ? `no answer within ${timeoutMs}ms` : error.message}`,
        { provider, retryable: true },
      );

      if (attempt === retries) throw lastError;
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 16000)));
    }
  }

  throw lastError;
}

/** Read a key from the environment, and say which variable when it is absent. */
function requireKey(envVar, provider) {
  const key = process.env[envVar];

  if (!key) {
    throw new ProviderError(
      `${provider} needs ${envVar} in the environment. driftline never reads keys from a config file ` +
      'or writes one to history, so this is the only place it can come from.',
      { provider },
    );
  }

  return key;
}

/* ------------------------------------------------------------- adapters */

export const anthropic = {
  name: 'anthropic',
  defaultModel: 'claude-sonnet-5',
  envVar: 'ANTHROPIC_API_KEY',
  baseUrl: 'https://api.anthropic.com',

  async complete({ model, messages, system, temperature = 0, maxTokens = 1024, baseUrl, timeoutMs }) {
    const { body, headers } = await request(`${baseUrl ?? this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': requireKey(this.envVar, this.name),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model ?? this.defaultModel,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages,
      }),
    }, { provider: this.name, timeoutMs });

    const text = (body?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      usage: { input: body?.usage?.input_tokens ?? null, output: body?.usage?.output_tokens ?? null },
      stopReason: body?.stop_reason ?? null,
      identity: captureIdentity(body, headers),
    };
  },
};

export const openai = {
  name: 'openai',
  defaultModel: 'gpt-4.1',
  envVar: 'OPENAI_API_KEY',
  baseUrl: 'https://api.openai.com',

  async complete({ model, messages, system, temperature = 0, maxTokens = 1024, seed, baseUrl, timeoutMs }) {
    const all = system ? [{ role: 'system', content: system }, ...messages] : messages;

    const { body, headers } = await request(`${baseUrl ?? this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${requireKey(this.envVar, this.name)}`,
      },
      body: JSON.stringify({
        model: model ?? this.defaultModel,
        messages: all,
        temperature,
        max_completion_tokens: maxTokens,
        // Documented as best effort rather than a guarantee, which is the
        // whole reason system_fingerprint exists next to it.
        ...(seed !== undefined ? { seed } : {}),
      }),
    }, { provider: this.name, timeoutMs });

    const choice = body?.choices?.[0];

    return {
      text: choice?.message?.content ?? '',
      usage: { input: body?.usage?.prompt_tokens ?? null, output: body?.usage?.completion_tokens ?? null },
      stopReason: choice?.finish_reason ?? null,
      identity: captureIdentity(body, headers),
    };
  },
};

export const google = {
  name: 'google',
  defaultModel: 'gemini-2.5-pro',
  envVar: 'GOOGLE_API_KEY',
  baseUrl: 'https://generativelanguage.googleapis.com',

  async complete({ model, messages, system, temperature = 0, maxTokens = 1024, baseUrl, timeoutMs }) {
    const id = model ?? this.defaultModel;

    const { body, headers } = await request(
      `${baseUrl ?? this.baseUrl}/v1beta/models/${id}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': requireKey(this.envVar, this.name),
        },
        body: JSON.stringify({
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      },
      { provider: this.name, timeoutMs },
    );

    const candidate = body?.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');

    return {
      text,
      usage: {
        input: body?.usageMetadata?.promptTokenCount ?? null,
        output: body?.usageMetadata?.candidatesTokenCount ?? null,
      },
      stopReason: candidate?.finishReason ?? null,
      identity: captureIdentity(body, headers),
    };
  },
};

/**
 * Anything speaking the OpenAI chat shape.
 *
 * Groq, Together, OpenRouter, vLLM, Ollama, LM Studio and every self-hosted
 * gateway. Worth having as its own entry rather than telling people to
 * override openai's base url, because the self-hosted case is where drift is
 * most likely to be somebody else's deploy rather than a vendor's, and the
 * report should be able to say which.
 */
export const compatible = {
  ...openai,
  name: 'compatible',
  defaultModel: null,
  envVar: 'OPENAI_COMPATIBLE_API_KEY',
  baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'http://localhost:11434',

  async complete(options) {
    if (!options.model && !this.defaultModel) {
      throw new ProviderError('the compatible provider needs an explicit model on the probe', { provider: this.name });
    }
    // A local gateway usually wants no key at all, so an absent one is not an
    // error here the way it is against a hosted API.
    const key = process.env[this.envVar] ?? 'not-required';
    const original = process.env[this.envVar];
    process.env[this.envVar] = key;

    try {
      return await openai.complete.call(
        { ...openai, name: this.name, envVar: this.envVar, baseUrl: this.baseUrl },
        options,
      );
    } finally {
      if (original === undefined) delete process.env[this.envVar];
      else process.env[this.envVar] = original;
    }
  },
};

export const PROVIDERS = { anthropic, openai, google, compatible };

export function resolveProvider(name) {
  const provider = PROVIDERS[name];

  if (!provider) {
    throw new ProviderError(
      `no provider named "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}. ` +
      'Anything speaking the OpenAI chat shape works through "compatible".',
      { provider: name },
    );
  }

  return provider;
}
