import { describe, expect, it } from 'vitest';
import type { AnyTool, ToolContext } from '../../../src/main/tools/types';
import { mediaAppName, mediaTools } from '../../../src/main/tools/media/tools';
import { audioTools, findDevice } from '../../../src/main/tools/system/audio';
import { describeElement, findElement, findText, uiTools } from '../../../src/main/tools/ui/tools';
import { windowTools } from '../../../src/main/tools/windows/tools';
import { FakeWindows, el } from '../fakes';

function ctx(options: { approve?: boolean; activeWindow?: number } = {}) {
  const asked: string[] = [];
  const context: ToolContext = {
    activeWindow: options.activeWindow ?? null,
    signal: new AbortController().signal,
    confirm: async (summary) => {
      asked.push(summary);
      return options.approve ?? true;
    },
  };
  return { context, asked };
}

function tool(tools: AnyTool[], name: string): AnyTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const run = (t: AnyTool, args: unknown, c: ToolContext) => t.run(t.input.parse(args), c);

describe('media tools', () => {
  it('pauses explicitly instead of toggling, and names the track on play and skip', async () => {
    const win = new FakeWindows();
    const media = tool(mediaTools(win), 'media_control');
    expect((await run(media, { action: 'pause' }, ctx().context)).speak).toBe('Paused.');
    expect((await run(media, { action: 'play' }, ctx().context)).speak).toBe(
      'Playing Song A by Band.',
    );
    expect((await run(media, { action: 'next', app: 'Spotify' }, ctx().context)).speak).toBe(
      'Next up: Song B by Band.',
    );
    expect(win.mediaCommands.map((c) => c.action)).toEqual(['pause', 'play', 'next']);
    expect(win.mediaCommands[2]!.app).toBe('spotify');
    expect(win.media).toEqual([]);
  });

  it('falls back to the media key when no app reports a session', async () => {
    const win = new FakeWindows();
    win.sessions = [];
    const media = tool(mediaTools(win), 'media_control');
    expect((await run(media, { action: 'pause' }, ctx().context)).ok).toBe(true);
    expect(win.media).toEqual(['play_pause']);
    const named = await run(media, { action: 'play', app: 'spotify' }, ctx().context);
    expect(named.ok).toBe(false);
  });

  it("says what's playing, or what's paused", async () => {
    const win = new FakeWindows();
    const now = tool(mediaTools(win), 'now_playing');
    expect((await run(now, {}, ctx().context)).speak).toBe('Song A by Band, on Spotify.');
    win.sessions[0]!.status = 'paused';
    expect((await run(now, {}, ctx().context)).speak).toBe(
      'Nothing is playing. Song A by Band is paused on Spotify.',
    );
  });

  it('turns Windows app ids into names', () => {
    expect(mediaAppName('Spotify.exe')).toBe('Spotify');
    expect(mediaAppName('F0DC299D809B9700')).toBe('your browser');
    expect(mediaAppName('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic')).toBe(
      'Media Player',
    );
  });
});

describe('ui tools', () => {
  const sensitive = ['1Password', 'bank'];

  function setup() {
    const win = new FakeWindows();
    win.windows.push(
      { handle: 4, title: 'Vault - 1Password', process: '1Password', pid: 13, minimized: false },
      {
        handle: 5,
        title: 'Chase Bank - Google Chrome',
        process: 'chrome',
        pid: 11,
        minimized: false,
      },
    );
    win.ui.set(3, [
      el(1, 'button', 'Upload a file'),
      el(2, 'edit', 'Message #general', { value: 'hi' }),
      el(3, 'button', 'Send'),
      el(4, 'text', 'general'),
    ]);
    win.ui.set(4, [el(1, 'edit', 'Master password', { password: true })]);
    const tools = uiTools({ win, sensitiveApps: () => sensitive });
    return { win, tools };
  }

  it('clicks a control by name, asking first when it sends something', async () => {
    const { win, tools } = setup();
    const click = tool(tools, 'click');
    const upload = await run(click, { target: 'upload file', window: 'discord' }, ctx().context);
    expect(upload).toMatchObject({ ok: true, speak: 'Clicked Upload a file.' });

    const declined = ctx({ approve: false });
    const send = await run(click, { target: 'send', window: 'discord' }, declined.context);
    expect(send.cancelled).toBe(true);
    expect(declined.asked).toEqual(['Click “Send” in Discord']);
    expect(win.clicked).toEqual([1]);

    await run(click, { target: 'send', window: 'discord' }, ctx({ approve: true }).context);
    expect(win.clicked).toEqual([1, 3]);
  });

  it('never reads a sensitive window, by app name or by title word', async () => {
    const { win, tools } = setup();
    for (const window of ['1password', 'chase bank']) {
      const read = await run(tool(tools, 'read_screen'), { window }, ctx().context);
      expect(read.ok).toBe(false);
      expect(read.speak).toMatch(/sensitive apps list/);
      const click = await run(tool(tools, 'click'), { target: 'unlock', window }, ctx().context);
      expect(click.ok).toBe(false);
    }
    // The window the user was using counts too.
    const active = await run(tool(tools, 'read_screen'), {}, ctx({ activeWindow: 4 }).context);
    expect(active.ok).toBe(false);
    expect(win.snapshots).toEqual([]);
    expect(win.ocrReads).toEqual([]);
  });

  it('lists controls for the model, without password contents', async () => {
    const { tools } = setup();
    const read = await run(tool(tools, 'read_screen'), { window: 'discord' }, ctx().context);
    expect(read.data).toMatchObject({
      elements: [
        '#1 button "Upload a file"',
        '#2 edit "Message #general" = "hi"',
        '#3 button "Send"',
        '#4 text "general"',
      ],
    });
    expect(describeElement(el(9, 'edit', 'Password', { password: true, value: 'x' }))).toBe(
      '#9 edit "Password" (password field, contents hidden)',
    );
  });

  it('clicks by #id from read_screen, still checking risky names', async () => {
    const { win, tools } = setup();
    await run(tool(tools, 'read_screen'), { window: 'discord' }, ctx().context);
    const asked = ctx({ approve: false });
    await run(tool(tools, 'click'), { element: 3, window: 'discord' }, asked.context);
    expect(asked.asked).toEqual(['Click “Send” in Discord']);
    expect(win.clicked).toEqual([]);
  });

  it('falls back to text on screen when UI Automation has nothing', async () => {
    const { win, tools } = setup();
    win.ocr.set(1, [
      {
        text: 'Liked Songs Play',
        words: [
          { text: 'Liked', x: 100, y: 50, w: 40, h: 20 },
          { text: 'Songs', x: 150, y: 50, w: 50, h: 20 },
          { text: 'Play', x: 300, y: 50, w: 30, h: 20 },
        ],
      },
    ]);
    const result = await run(
      tool(tools, 'click'),
      { target: 'liked songs', window: 'spotify' },
      ctx().context,
    );
    expect(result).toMatchObject({ ok: true, speak: 'Clicked Liked Songs.' });
    expect(win.clickedAt).toEqual([{ x: 150, y: 60 }]);
  });

  it('types into a named field and asks before sending', async () => {
    const { win, tools } = setup();
    const type = tool(tools, 'type_text');
    await run(type, { text: 'hello', field: 'message', window: 'discord' }, ctx().context);
    expect(win.focusedElements).toEqual([2]);
    expect(win.typed).toEqual(['hello']);

    const asked = ctx({ approve: false });
    const sent = await run(
      type,
      { text: 'see you', window: 'discord', submit: true },
      asked.context,
    );
    expect(sent.cancelled).toBe(true);
    expect(asked.asked).toEqual(['Send “see you” in Discord']);
    expect(win.typed).toEqual(['hello']);
    expect(win.keys).toEqual([]);
  });

  it('asks before shortcuts that close things', async () => {
    const { win, tools } = setup();
    const keys = tool(tools, 'press_keys');
    const asked = ctx({ approve: false, activeWindow: 2 });
    await run(keys, { keys: 'alt+f4' }, asked.context);
    expect(asked.asked).toHaveLength(1);
    await run(keys, { keys: 'ctrl+t' }, ctx({ activeWindow: 2 }).context);
    expect(win.keys).toEqual(['ctrl+t']);
  });

  it('hides sensitive window titles from the window list', async () => {
    const { win } = setup();
    const list = tool(
      windowTools(win, () => sensitive),
      'list_windows',
    );
    const result = await run(list, {}, ctx().context);
    const titles = (result.data as { windows: { title: string }[] }).windows.map((w) => w.title);
    expect(titles).toContain('(hidden: sensitive app)');
    expect(titles.join(' ')).not.toMatch(/Vault|Chase/);
  });

  it('matches names and on-screen words', () => {
    const { best } = findElement([el(1, 'button', 'Send'), el(2, 'text', 'Send')], 'send');
    expect(best?.id).toBe(1);
    expect(findElement([el(1, 'button', 'Mute')], 'send').best).toBeNull();
    expect(
      findText([{ text: 'OK', words: [{ text: 'OK', x: 0, y: 0, w: 10, h: 10 }] }], 'ok'),
    ).toEqual({ x: 5, y: 5, text: 'OK' });
  });
});

describe('per-app volume and output devices', () => {
  it("sets one app's volume or mute by a spoken name", async () => {
    const win = new FakeWindows();
    const tools = audioTools(win);
    const set = tool(tools, 'set_app_volume');
    expect((await run(set, { app: 'spotify', level: 30 }, ctx().context)).speak).toBe(
      'Spotify volume set to 30%.',
    );
    expect((await run(set, { app: 'discord', muted: true }, ctx().context)).speak).toBe(
      'Muted Discord.',
    );
    expect(win.appVolumes).toEqual([
      { process: 'Spotify', level: 30, muted: false },
      { process: 'Discord', level: 80, muted: true },
    ]);
    const missing = await run(set, { app: 'steam', level: 10 }, ctx().context);
    expect(missing).toMatchObject({ ok: false, followUp: true });
  });

  it('switches the output device by kind or name', async () => {
    const win = new FakeWindows();
    const device = tool(audioTools(win), 'set_output_device');
    expect((await run(device, { device: 'headphones' }, ctx().context)).speak).toBe(
      'Switched to WH-1000XM4 headphones.',
    );
    expect(win.devices.find((d) => d.default)?.id).toBe('hp');
    expect((await run(device, { device: 'my speakers' }, ctx().context)).speak).toBe(
      'Switched to Realtek Audio speakers.',
    );
    expect((await run(device, { device: 'the fridge' }, ctx().context)).ok).toBe(false);
  });

  it('matches device kinds against Windows names', () => {
    const devices = [
      { id: 'a', name: 'LG ULTRAGEAR (NVIDIA High Definition Audio)', default: false },
      { id: 'b', name: 'Speakers (JBL Flip 5)', default: true },
    ];
    expect(findDevice(devices, 'jbl')?.id).toBe('b');
    expect(findDevice(devices, 'monitor')?.id).toBe('a');
    expect(findDevice(devices, 'speakers')?.id).toBe('b');
  });
});
