import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AssistantEvent } from '../../../src/shared/assistant';
import { Assistant } from '../../../src/main/agent/assistant';
import { PrivacyGuard } from '../../../src/main/privacy/guard';
import { ProviderError, type LlmProvider } from '../../../src/main/providers/llm/types';
import { QuotaTracker } from '../../../src/main/router/quota';
import { LlmRouter } from '../../../src/main/router/router';
import { JsonlLog } from '../../../src/main/safety/action-log';
import { ToolExecutor, type ConfirmRequest } from '../../../src/main/safety/executor';
import { AppIndex } from '../../../src/main/tools/apps/app-index';
import { appTools } from '../../../src/main/tools/apps/tools';
import { timeTools } from '../../../src/main/tools/info/time';
import { ToolRegistry } from '../../../src/main/tools/registry';
import { audioTools } from '../../../src/main/tools/system/audio';
import { mediaTools } from '../../../src/main/tools/media/tools';
import { windowTools } from '../../../src/main/tools/windows/tools';
import { FakeProvider, FakeWindows, tempDir } from '../fakes';
import { MemoryStore } from '../../../src/main/memory/memory';
import type { Routine } from '../../../src/shared/settings';

function setup(options: {
  providers?: LlmProvider[];
  approve?: boolean;
  customValues?: string[];
  limits?: Record<string, number>;
  hasNetwork?: boolean;
  routines?: Routine[];
  memory?: MemoryStore;
}) {
  const dir = tempDir();
  const win = new FakeWindows();
  const launched: string[] = [];
  const opened: string[] = [];
  const confirms: ConfirmRequest[] = [];
  const events: AssistantEvent[] = [];
  const guard = new PrivacyGuard(() => ({
    maskContactInfo: false,
    customValues: options.customValues ?? [],
  }));
  const registry = new ToolRegistry().register(
    ...audioTools(win),
    ...mediaTools({ win }),
    ...appTools(win, new AppIndex(win), {
      launchApp: (id) => launched.push(id),
      openUrl: async (url) => void opened.push(url),
    }),
    ...windowTools(win),
    ...timeTools(),
  );
  const actions = new JsonlLog(join(dir, 'logs'), 'actions');
  const outbound = new JsonlLog(join(dir, 'logs'), 'outbound');
  const executor = new ToolExecutor(
    registry,
    guard,
    async (req) => {
      confirms.push(req);
      return options.approve ?? true;
    },
    actions,
  );
  const quota = new QuotaTracker(join(dir, 'quota.json'));
  const router = new LlmRouter(
    () =>
      (options.providers ?? []).map((provider) => ({
        provider,
        dailyLimit: options.limits?.[provider.id] ?? 100,
      })),
    quota,
    outbound,
  );
  const assistant = new Assistant({
    guard,
    registry,
    executor,
    router,
    log: actions,
    emit: (e) => events.push(e),
    hasNetwork: () => options.hasNetwork ?? true,
    routines: () => options.routines ?? [],
    memory: options.memory,
  });
  const readLogs = () =>
    readdirSync(join(dir, 'logs'))
      .map((f) => readFileSync(join(dir, 'logs', f), 'utf8'))
      .join('\n');
  const run = (text: string) => assistant.handle(text, { source: 'palette', activeWindow: 2 });
  return { run, win, launched, opened, confirms, events, quota, readLogs };
}

describe('Assistant: instant path', () => {
  it('runs "open spotify and set volume to 30" locally with no LLM call', async () => {
    const gemini = new FakeProvider('gemini', []);
    const t = setup({ providers: [gemini] });
    const reply = await t.run('open spotify and set volume to 30');
    expect(reply).toBe('Opening Spotify. Volume set to 30%.');
    // Spotify is already running: its window is brought forward instead of launching it again.
    expect(t.launched).toEqual([]);
    expect(t.win.actions).toEqual([{ handle: 1, action: 'focus' }]);
    expect(t.win.volume.level).toBe(30);
    expect(gemini.requests).toHaveLength(0);
  });

  it('uses the active window for "snap this left"', async () => {
    const t = setup({});
    expect(await t.run('snap this left')).toBe('Snapped left: Chrome.');
    expect(t.win.actions).toEqual([{ handle: 2, action: 'snap_left' }]);
  });

  it('asks before closing an app, and respects "no"', async () => {
    const t = setup({ approve: false });
    expect(await t.run('close discord')).toBe("Okay, I won't do that.");
    expect(t.confirms.map((c) => c.summary)).toEqual(['Close discord']);
    expect(t.win.actions).toEqual([]);
  });

  it('keeps locally run commands in the history for follow-ups', async () => {
    const gemini = new FakeProvider('gemini', [{ text: 'Sure.', toolCalls: [] }]);
    const t = setup({ providers: [gemini] });
    await t.run('open spotify');
    await t.run('and make it quieter than usual');
    const messages = gemini.requests[0]!.messages;
    expect(messages.slice(0, 2)).toEqual([
      { role: 'user', text: 'open spotify' },
      { role: 'assistant', text: 'Opening Spotify.' },
    ]);
    expect(messages.at(-1)).toEqual({ role: 'user', text: 'and make it quieter than usual' });
  });

  it('falls back to the LLM when the instant guess finds no app', async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [{ id: 'c1', name: 'open_app', args: { name: 'Visual Studio Code' } }],
      },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('open my code editor thing')).toBe('Opening Visual Studio Code.');
    expect(gemini.requests).toHaveLength(1);
  });
});

describe('Assistant: LLM path', () => {
  it('skips the second round trip when tools already said everything', async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'media_control', args: { action: 'next' } },
          { id: 'b', name: 'change_volume', args: { delta: -20 } },
        ],
      },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('this song is too loud and I hate it')).toBe(
      'Next up: Song B by Band. Volume down to 30%.',
    );
    expect(gemini.requests).toHaveLength(1);
  });

  it('sends results back when the model needs to look at them', async () => {
    const gemini = new FakeProvider('gemini', [
      { text: '', toolCalls: [{ id: 'a', name: 'list_windows', args: {} }] },
      { text: 'You have Spotify, Chrome and Discord open.', toolCalls: [] },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run("what's open right now")).toBe('You have Spotify, Chrome and Discord open.');
    expect(gemini.requests).toHaveLength(2);
    expect(gemini.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('falls back to Groq when Gemini is rate-limited, and cools Gemini down', async () => {
    const gemini = new FakeProvider('gemini', [
      new ProviderError('rate_limit', 'Gemini: 429', 30_000),
    ]);
    const groq = new FakeProvider('groq', [{ text: 'Hello!', toolCalls: [] }]);
    const t = setup({ providers: [gemini, groq] });
    expect(await t.run('say hi')).toBe('Hello!');
    expect(t.quota.isCoolingDown('gemini')).toBe(true);
    expect(groq.requests).toHaveLength(1);
  });

  it('skips a provider that used its daily quota', async () => {
    const gemini = new FakeProvider('gemini', []);
    const groq = new FakeProvider('groq', [{ text: 'Hi from Groq.', toolCalls: [] }]);
    const t = setup({ providers: [gemini, groq], limits: { gemini: 0 } });
    expect(await t.run('say hi')).toBe('Hi from Groq.');
    expect(gemini.requests).toHaveLength(0);
  });

  it('explains what to do when no provider is set up', async () => {
    const t = setup({ providers: [] });
    expect(await t.run('tell me a joke')).toMatch(/Add a free Gemini or Groq key in Settings/);
    expect(t.events.at(-1)).toMatchObject({ type: 'reply', ok: false });
  });
});

describe('Assistant: replies after several passes', () => {
  it('says the actions of every pass, in the order they ran', async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'media_control', args: { action: 'pause' } },
          { id: 'm', name: 'more_tools', args: { groups: ['audio'] } },
        ],
      },
      {
        text: '',
        toolCalls: [{ id: 'b', name: 'set_app_volume', args: { app: 'Discord', muted: true } }],
      },
    ]);
    const t = setup({ providers: [gemini] });
    // "Added tools for: …" is for the model, so it is not part of the reply.
    expect(await t.run('silence Discord and stop whatever song is on')).toBe(
      'Paused. Muted Discord.',
    );
    expect(gemini.requests).toHaveLength(2);
    expect(t.win.mediaCommands).toEqual([{ action: 'pause', app: undefined }]);
    expect(t.win.appVolumes.find((a) => a.process === 'Discord')!.muted).toBe(true);
  });

  it('leaves out a look-up made on the way to an action', async () => {
    const gemini = new FakeProvider('gemini', [
      { text: '', toolCalls: [{ id: 'a', name: 'list_windows', args: {} }] },
      {
        text: '',
        toolCalls: [
          { id: 'b', name: 'window_action', args: { action: 'minimize', target: 'Discord' } },
        ],
      },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('hide the chat window')).toBe('Minimized Discord.');
    expect(t.win.actions).toEqual([{ handle: 3, action: 'minimize' }]);
  });

  it('leaves out a failed attempt when the retry works', async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'window_action', args: { action: 'minimize', target: 'the chat' } },
        ],
      },
      {
        text: '',
        toolCalls: [
          { id: 'b', name: 'window_action', args: { action: 'minimize', target: 'Discord' } },
        ],
      },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('hide the chat window')).toBe('Minimized Discord.');
    expect(gemini.requests).toHaveLength(2);
  });

  it('keeps an action that worked when another in the same pass failed', async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'media_control', args: { action: 'pause' } },
          { id: 'b', name: 'window_action', args: { action: 'minimize', target: 'the chat' } },
        ],
      },
      {
        text: '',
        toolCalls: [
          { id: 'c', name: 'window_action', args: { action: 'minimize', target: 'Discord' } },
        ],
      },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('stop the music and hide the chat window')).toBe(
      'Paused. Minimized Discord.',
    );
  });

  it("uses the model's own words when it ends with text", async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'media_control', args: { action: 'pause' } },
          { id: 'b', name: 'list_windows', args: {} },
        ],
      },
      { text: 'I paused the music. Discord is still open.', toolCalls: [] },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('stop the music and tell me if discord is open')).toBe(
      'I paused the music. Discord is still open.',
    );
  });

  it('says what was done when the model ends without any text', async () => {
    const gemini = new FakeProvider('gemini', [
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'media_control', args: { action: 'pause' } },
          { id: 'b', name: 'list_windows', args: {} },
        ],
      },
      { text: '', toolCalls: [] },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('stop the music and check the windows')).toBe('Paused.');
  });

  it('still says "Done." when the model ends without text and nothing was done', async () => {
    const gemini = new FakeProvider('gemini', [
      { text: '', toolCalls: [{ id: 'a', name: 'list_windows', args: {} }] },
      { text: '', toolCalls: [] },
    ]);
    const t = setup({ providers: [gemini] });
    expect(await t.run('check the windows')).toBe('Done.');
  });
});

describe('Privacy: nothing sensitive reaches a provider or a log', () => {
  const CORPUS = [
    '4111 1111 1111 1111',
    '378282246310005',
    '123-45-6789',
    '021000021',
    'GB82 WEST 1234 5698 7654 32',
    'hunter2!',
    'AKIAIOSFODNN7EXAMPLE',
    'Zq8vN3kP2mL9xR4tW7yB1cF6hJ0dS5aG',
    '482913',
    '000123456789',
    '42 Wallaby Way',
  ];
  const SENTENCES = [
    'remember my card 4111 1111 1111 1111 and my amex 378282246310005',
    'my ssn is 123-45-6789 and routing number 021000021',
    'wire it to GB82 WEST 1234 5698 7654 32 from checking account 000123456789',
    'my password is hunter2! and the verification code is 482913',
    'here is the key AKIAIOSFODNN7EXAMPLE and token Zq8vN3kP2mL9xR4tW7yB1cF6hJ0dS5aG',
    'ship it to 42 Wallaby Way',
  ];

  it('scrubs user text, tool results and logs', async () => {
    const gemini = new FakeProvider('gemini', [
      ...SENTENCES.map(() => ({ text: 'Noted.', toolCalls: [] })),
      // A tool whose result contains a card number in a window title.
      { text: '', toolCalls: [{ id: 'w', name: 'list_windows', args: {} }] },
      { text: 'Done looking.', toolCalls: [] },
    ]);
    const t = setup({ providers: [gemini], customValues: ['42 Wallaby Way'] });
    t.win.windows.push({
      handle: 9,
      title: 'Checkout 4111 1111 1111 1111 - Edge',
      process: 'msedge',
      pid: 20,
      minimized: false,
    });

    for (const sentence of SENTENCES) await t.run(sentence);
    await t.run('which windows are open');

    const sent = JSON.stringify(gemini.requests);
    const logs = t.readLogs();
    for (const secret of CORPUS) {
      expect(sent, `provider saw ${secret}`).not.toContain(secret);
      expect(logs, `logs contain ${secret}`).not.toContain(secret);
    }
    expect(sent).toContain('[CARD_1]');
    expect(sent).toContain('[CUSTOM_1]');
    expect(logs).toContain('"type":"outbound"');
  });

  it('fills placeholders back in locally, but only after confirmation', async () => {
    const gemini = new FakeProvider('gemini', [
      (req) => {
        const user = JSON.stringify(req.messages);
        expect(user).toContain('[CARD_1]');
        return {
          text: '',
          toolCalls: [
            { id: 'x', name: 'open_url', args: { url: 'shop.example.com/pay?c=[CARD_1]' } },
          ],
        };
      },
    ]);
    const t = setup({ providers: [gemini], approve: false });
    expect(await t.run('pay with 4111 1111 1111 1111 on shop.example.com')).toBe(
      "Okay, I won't do that.",
    );
    expect(t.confirms).toHaveLength(1);
    expect(t.confirms[0]!.usesSensitiveValue).toBe(true);
    expect(t.confirms[0]!.summary).toContain('[CARD_1]');
    expect(t.opened).toEqual([]);
  });
});

describe('Assistant: offline', () => {
  it('does local commands but skips the AI when there is no network', async () => {
    const gemini = new FakeProvider('gemini', []);
    const t = setup({ providers: [gemini], hasNetwork: false });
    expect(await t.run('set volume to 30')).toBe('Volume set to 30%.');
    expect(await t.run('what is the capital of France')).toMatch(/offline/);
    expect(gemini.requests).toHaveLength(0);
  });
});

describe('Assistant: tool selection', () => {
  it('sends only the tools a request needs, and more when the model asks', async () => {
    const gemini = new FakeProvider('gemini', [
      // The request looked like it was about windows, but it needs the clock.
      { text: '', toolCalls: [{ id: 'm1', name: 'more_tools', args: { groups: ['time'] } }] },
      { text: '', toolCalls: [{ id: 'c1', name: 'get_time', args: {} }] },
    ]);
    const t = setup({ providers: [gemini] });
    const reply = await t.run('bring up the window thing and tell me how late it is');
    expect(reply).toMatch(/^It's /);
    const first = gemini.requests[0]!.tools.map((s) => s.name);
    expect(first).toContain('window_action');
    expect(first).toContain('more_tools');
    expect(first).not.toContain('get_time');
    expect(first).not.toContain('set_volume');
    const second = gemini.requests[1]!.tools.map((s) => s.name);
    expect(second).toContain('get_time');
    // The model saw a result for its more_tools call.
    expect(gemini.requests[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      results: [{ name: 'more_tools' }],
    });
  });

  it('sends every tool when the request matches no group', async () => {
    const gemini = new FakeProvider('gemini', [{ text: 'Paris.', toolCalls: [] }]);
    const t = setup({ providers: [gemini] });
    await t.run('what is the capital of France');
    const names = gemini.requests[0]!.tools.map((s) => s.name);
    expect(names).toContain('set_volume');
    expect(names).toContain('get_time');
    expect(names).not.toContain('more_tools');
  });
});

describe('Assistant: routines and memory', () => {
  it("runs a routine's commands in order and answers once", async () => {
    const gemini = new FakeProvider('gemini', []);
    const t = setup({
      providers: [gemini],
      routines: [
        { name: 'Gaming mode', steps: ['open spotify', 'set volume to 40', 'snap this left'] },
      ],
    });
    expect(await t.run('Hey Aida, start gaming mode.')).toBe(
      'Opening Spotify. Volume set to 40%. Snapped left: Chrome.',
    );
    expect(t.win.volume.level).toBe(40);
    expect(gemini.requests).toHaveLength(0);
    expect(t.events.filter((e) => e.type === 'reply')).toHaveLength(1);
    expect(t.readLogs()).toContain('"route":"routine"');
  });

  it('keeps going after a failed step', async () => {
    const t = setup({
      providers: [],
      routines: [{ name: 'focus', steps: ['write my essay for me', 'set volume to 10'] }],
    });
    const reply = await t.run('focus mode');
    expect(reply).toMatch(/Volume set to 10%\.$/);
    expect(t.win.volume.level).toBe(10);
  });

  it('applies nicknames and sends remembered facts with AI requests', async () => {
    const memory = new MemoryStore(join(tempDir(), 'memory.json'), () => false);
    memory.setNickname('my music app', 'Spotify');
    memory.remember('I like jazz');
    const gemini = new FakeProvider('gemini', [{ text: 'Try some Coltrane.', toolCalls: [] }]);
    const t = setup({ providers: [gemini], memory });
    expect(await t.run('open my music app')).toBe('Opening Spotify.');
    expect(await t.run('what should I listen to')).toBe('Try some Coltrane.');
    expect(gemini.requests[0]!.system).toContain('The user asked you to remember: I like jazz.');
  });
});
