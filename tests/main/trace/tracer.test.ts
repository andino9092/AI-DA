import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Assistant } from '../../../src/main/agent/assistant';
import { PrivacyGuard } from '../../../src/main/privacy/guard';
import { ProviderError, type LlmProvider } from '../../../src/main/providers/llm/types';
import { QuotaTracker } from '../../../src/main/router/quota';
import { LlmRouter } from '../../../src/main/router/router';
import { JsonlLog } from '../../../src/main/safety/action-log';
import { ToolExecutor } from '../../../src/main/safety/executor';
import { AppIndex } from '../../../src/main/tools/apps/app-index';
import { appTools } from '../../../src/main/tools/apps/tools';
import { ToolRegistry } from '../../../src/main/tools/registry';
import { audioTools } from '../../../src/main/tools/system/audio';
import { Tracer, type TraceEntry } from '../../../src/main/trace/tracer';
import { FakeProvider, FakeWindows, tempDir } from '../fakes';

/** A clock the test moves by hand. */
function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
}

describe('Trace', () => {
  it('records spans with their offset and writes one entry at the end', async () => {
    const c = clock();
    const entries: TraceEntry[] = [];
    const trace = new Tracer((e) => entries.push(e), c.now).start('voice', 300);
    trace.add({ name: 'stt', audioSeconds: 1.5, reused: true }, 300);
    c.tick(50);
    await trace.time(
      () => ({ name: 'tool', tool: 'set_volume', ok: true }),
      async () => c.tick(20),
    );
    trace.routed('instant');
    trace.routed('llm');
    c.tick(130);
    trace.end();
    trace.end();
    trace.add({ name: 'tts' }, 5);

    expect(entries).toEqual([
      {
        type: 'trace',
        requestId: trace.id,
        source: 'voice',
        route: 'instant',
        ok: true,
        totalMs: 500,
        spans: [
          { name: 'stt', audioSeconds: 1.5, reused: true, at: 0, ms: 300 },
          { name: 'tool', tool: 'set_volume', ok: true, at: 350, ms: 20 },
        ],
      },
    ]);
  });

  it('records a stage that throws, and passes the error on', async () => {
    const c = clock();
    const entries: TraceEntry[] = [];
    const trace = new Tracer((e) => entries.push(e), c.now).start('palette');
    await expect(
      trace.time(
        (_result, err) => ({ name: 'tool', tool: 'click', ok: !err }),
        async () => {
          c.tick(7);
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    trace.outcome(false);
    trace.end();
    expect(entries[0]).toMatchObject({
      ok: false,
      spans: [{ name: 'tool', tool: 'click', ok: false, ms: 7 }],
    });
  });
});

describe('tracing a request', () => {
  function setup(providers: LlmProvider[], approve = true) {
    const dir = tempDir();
    const win = new FakeWindows();
    const entries: TraceEntry[] = [];
    const guard = new PrivacyGuard(() => ({ maskContactInfo: false, customValues: [] }));
    const registry = new ToolRegistry().register(
      ...audioTools(win),
      ...appTools(win, new AppIndex(win), { launchApp: () => {}, openUrl: async () => {} }),
    );
    const log = new JsonlLog(join(dir, 'logs'), 'actions');
    const executor = new ToolExecutor(registry, guard, async () => approve, log);
    const router = new LlmRouter(
      () => providers.map((provider) => ({ provider, dailyLimit: 100 })),
      new QuotaTracker(join(dir, 'quota.json')),
      new JsonlLog(join(dir, 'logs'), 'outbound'),
      undefined,
      { sleep: async () => {} },
    );
    const tracer = new Tracer((e) => entries.push(e));
    const assistant = new Assistant({
      guard,
      registry,
      executor,
      router,
      log,
      emit: () => {},
      tracer,
    });
    return { assistant, entries, tracer };
  }
  const options = { source: 'palette' as const, activeWindow: null };

  it('traces an instant command: one tool, no model', async () => {
    const { assistant, entries } = setup([]);
    await assistant.handle('set the volume to 30', options);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'palette', route: 'instant', ok: true });
    expect(entries[0]!.spans.map((s) => s.name)).toEqual(['tool']);
    expect(entries[0]!.spans[0]).toMatchObject({ tool: 'set_volume', ok: true });
  });

  it('traces model calls with tokens, failed attempts, tools and confirmations', async () => {
    const down = new FakeProvider('gemini', [new ProviderError('rate_limit', 'slow down')]);
    const up = new FakeProvider('groq', [
      {
        text: '',
        toolCalls: [{ id: '1', name: 'close_app', args: { name: 'Spotify' } }],
        usage: { inputTokens: 1200, outputTokens: 30 },
      },
    ]);
    const { assistant, entries } = setup([down, up]);
    await assistant.handle('I am done with music, get rid of Spotify', options);

    const [trace] = entries;
    expect(trace).toMatchObject({ route: 'llm', ok: true });
    expect(trace!.spans).toMatchObject([
      { name: 'llm', provider: 'gemini', model: 'gemini-test', error: 'rate_limit' },
      { name: 'llm', provider: 'groq', inputTokens: 1200, outputTokens: 30 },
      { name: 'confirm', approved: true },
      { name: 'tool', tool: 'close_app', ok: true },
    ]);
    expect(trace!.spans[1]).not.toHaveProperty('error');
    // Nothing the user said is in the trace.
    expect(JSON.stringify(trace)).not.toMatch(/Spotify|music/);
  });

  it('leaves a trace it was handed open for the caller to end', async () => {
    const { assistant, entries, tracer } = setup([]);
    const trace = tracer.start('voice');
    await assistant.handle('mute', { ...options, source: 'voice', trace });
    expect(entries).toHaveLength(0);
    trace.end();
    expect(entries[0]).toMatchObject({ source: 'voice', route: 'instant', requestId: trace.id });
  });
});
