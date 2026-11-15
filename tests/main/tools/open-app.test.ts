import { describe, expect, it } from 'vitest';
import { AppIndex } from '../../../src/main/tools/apps/app-index';
import { appTools } from '../../../src/main/tools/apps/tools';
import { FakeWindows } from '../fakes';

function setup() {
  const win = new FakeWindows();
  const launched: string[] = [];
  const tools = appTools(win, new AppIndex(win), {
    launchApp: (id) => void launched.push(id),
    openUrl: async () => {},
  });
  const openApp = tools.find((t) => t.name === 'open_app')!;
  const open = (name: string) =>
    openApp.run({ name } as never, {
      activeWindow: null,
      signal: new AbortController().signal,
      confirm: async () => true,
    });
  return { win, launched, open };
}

describe('open_app', () => {
  it('launches an app that is not running', async () => {
    const t = setup();
    expect(await t.open('vs code')).toEqual({ ok: true, speak: 'Opening Visual Studio Code.' });
    expect(t.launched).toEqual(['Microsoft.VisualStudioCode']);
    expect(t.win.actions).toEqual([]);
  });

  it('brings an open window to the front instead of launching again', async () => {
    const t = setup();
    expect(await t.open('chrome')).toEqual({ ok: true, speak: 'Opening Google Chrome.' });
    expect(t.launched).toEqual([]);
    expect(t.win.actions).toEqual([{ handle: 2, action: 'focus' }]);
  });

  it('shows the hidden window of an app closed to the tray', async () => {
    const t = setup();
    // Discord closed to the tray: still running, its main window hidden.
    t.win.hidden = t.win.windows.filter((w) => w.process === 'Discord');
    t.win.windows = t.win.windows.filter((w) => w.process !== 'Discord');
    expect(await t.open('discord')).toEqual({ ok: true, speak: 'Opening Discord.' });
    expect(t.win.shown).toEqual([3]);
    expect(t.launched).toEqual([]);
    expect(t.win.windows.some((w) => w.process === 'Discord')).toBe(true);
  });

  it('launches when the hidden window cannot be shown, or looking for one fails', async () => {
    const t = setup();
    t.win.hidden = t.win.windows.filter((w) => w.process === 'Discord');
    t.win.windows = t.win.windows.filter((w) => w.process !== 'Discord');
    t.win.showWindow = async () => false;
    await t.open('discord');
    expect(t.launched).toEqual(['com.squirrel.Discord.Discord']);

    const broken = setup();
    broken.win.listWindows = async () => {
      throw new Error('helper down');
    };
    await broken.open('spotify');
    expect(broken.launched).toEqual(['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']);
  });

  it('ignores a hidden window of the right process whose title is not the app', async () => {
    const t = setup();
    // Background processes keep hidden helper windows; only one titled like the app counts.
    t.win.windows = t.win.windows.filter((w) => w.process !== 'Discord');
    t.win.hidden = [
      { handle: 8, title: 'Crash handler', process: 'Discord', pid: 12, minimized: false },
    ];
    await t.open('discord');
    expect(t.win.shown).toEqual([]);
    expect(t.launched).toEqual(['com.squirrel.Discord.Discord']);
  });

  it("does not bring up another app's window", async () => {
    const t = setup();
    // A hidden window of some other process must not be shown for "open vs code".
    t.win.hidden = [{ handle: 9, title: 'Updater', process: 'Updater', pid: 99, minimized: false }];
    await t.open('vs code');
    expect(t.win.shown).toEqual([]);
    expect(t.launched).toEqual(['Microsoft.VisualStudioCode']);
  });
});
