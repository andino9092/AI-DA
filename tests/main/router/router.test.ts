import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivacyGuard } from '../../../src/main/privacy/guard';
import {
  ProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../../../src/main/providers/llm/types';
import { QuotaTracker } from '../../../src/main/router/quota';
import { LlmRouter, NoProviderError, testProvider } from '../../../src/main/router/router';
import { JsonlLog } from '../../../src/main/safety/action-log';
import { FakeProvider, tempDir } from '../fakes';

const request: LlmRequest = {
  system: PrivacyGuard.constant('test'),
  messages: [{ role: 'user', text: PrivacyGuard.constant('hi') }],
  tools: [],
};
const ok: LlmResponse = { text: 'Hello.', toolCalls: [] };
const overloaded = () =>
  new ProviderError('unavailable', 'Gemini: 503 high demand', undefined, 503);
const deadline = () => new ProviderError('unavailable', 'Gemini: 504 deadline', undefined, 504);
const badKey = () => new ProviderError('auth', 'Groq: 401 Invalid API Key', undefined, 401);

function setup(providers: LlmProvider[], attemptTimeoutMs?: number) {
  const dir = tempDir();
  const quota = new QuotaTracker(join(dir, 'quota.json'));
  const outbound = new JsonlLog(join(dir, 'logs'), 'outbound');
  const health: string[] = [];
  const router = new LlmRouter(
    () => providers.map((provider) => ({ provider, dailyLimit: 100 })),
    quota,
    outbound,
    { reached: () => health.push('reached'), unreachable: () => health.push('unreachable') },
    { sleep: async () => {}, attemptTimeoutMs },
  );
  const ask = () => router.complete(request, 'r1', new AbortController().signal);
  return { router, quota, health, ask, outbound };
}

async function failure(promise: Promise<unknown>): Promise<NoProviderError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NoProviderError) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('LlmRouter', () => {
  it('retries once when a provider says it is overloaded', async () => {
    const gemini = new FakeProvider('gemini', [overloaded(), ok]);
    const { ask, health } = setup([gemini]);
    await expect(ask()).resolves.toMatchObject({ text: 'Hello.', provider: 'gemini' });
    expect(gemini.requests).toHaveLength(2);
    expect(health).toEqual(['reached']);
  });

  it('moves on to the next provider after a second "overloaded" or a deadline error', async () => {
    const gemini = new FakeProvider('gemini', [overloaded(), overloaded(), deadline()]);
    const groq = new FakeProvider('groq', [ok, ok]);
    const { ask, quota } = setup([gemini, groq]);
    await expect(ask()).resolves.toMatchObject({ provider: 'groq' });
    expect(gemini.requests).toHaveLength(2);
    expect(quota.coolingReason('gemini')).toBe('busy');
    // While Gemini is marked busy, Groq goes first.
    await expect(ask()).resolves.toMatchObject({ provider: 'groq' });
    expect(gemini.requests).toHaveLength(2);
  });

  it('still tries a busy provider when nothing else works', async () => {
    const gemini = new FakeProvider('gemini', [deadline(), ok]);
    const groq = new FakeProvider('groq', [badKey()]);
    const { ask, quota } = setup([gemini, groq]);
    await failure(ask());
    expect(quota.coolingReason('gemini')).toBe('busy');
    expect(quota.coolingReason('groq')).toBe('auth');
    // Groq's key is rejected, so the busy Gemini is tried again instead of giving up at once.
    await expect(ask()).resolves.toMatchObject({ provider: 'gemini' });
    expect(quota.coolingReason('gemini')).toBeNull();
  });

  it('gives up on a provider that takes too long, without treating it as a cancel', async () => {
    const slow: LlmProvider = {
      id: 'gemini',
      model: 'slow',
      complete: (_req, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () =>
            reject(new ProviderError('aborted', 'Cancelled.')),
          ),
        ),
    };
    const groq = new FakeProvider('groq', [ok]);
    const { ask } = setup([slow, groq], 20);
    await expect(ask()).resolves.toMatchObject({ provider: 'groq' });
  });

  it('explains failures in plain words and keeps the raw errors for the log', async () => {
    const gemini = new FakeProvider('gemini', [overloaded(), overloaded()]);
    const groq = new FakeProvider('groq', [badKey()]);
    const { ask, health } = setup([gemini, groq]);
    const error = await failure(ask());
    expect(error.message).toBe(
      "I couldn't get an answer from the AI: Gemini is busy or unreachable right now, and Groq rejected its API key (use Test in Settings). Local commands like volume, music, apps and timers still work.",
    );
    expect(error.detail).toContain('Groq: 401 Invalid API Key');
    expect(error.detail).toContain('503 high demand');
    // A rejected key isn't a network problem: don't show the PC as offline.
    expect(health).toEqual([]);
  });

  it('marks the AI unreachable when every provider failed to answer', async () => {
    const gemini = new FakeProvider('gemini', [deadline()]);
    const { ask, health } = setup([gemini]);
    await failure(ask());
    expect(health).toEqual(['unreachable']);
  });
});

describe('testProvider', () => {
  const log = () => new JsonlLog(join(tempDir(), 'logs'), 'outbound');

  it('reports a working key with the model and time', async () => {
    const result = await testProvider(new FakeProvider('groq', [ok], 'qwen-x'), request, log());
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Works: qwen-x answered in \d+\.\d s\.$/);
  });

  it('tells an invalid key from a key that may not use the model', async () => {
    const invalid = await testProvider(new FakeProvider('groq', [badKey()]), request, log());
    expect(invalid.message).toBe(
      'Groq says the key is invalid (401). Copy a fresh key and save it again.',
    );
    const blocked = new ProviderError('auth', 'Groq: model blocked for org', undefined, 403);
    const forbidden = await testProvider(new FakeProvider('groq', [blocked], 'm'), request, log());
    expect(forbidden.message).toContain('refused access (403): model blocked for org');
    const missing = new ProviderError(
      'bad_request',
      'Groq: The model `m` does not exist',
      undefined,
      404,
    );
    const gone = await testProvider(new FakeProvider('groq', [missing], 'm'), request, log());
    expect(gone.message).toContain("doesn't offer the model “m”");
  });
});
