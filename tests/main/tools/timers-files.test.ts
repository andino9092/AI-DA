import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TimerService,
  formatDuration,
  parseDuration,
  timerMessage,
  timerTools,
  type Timer,
} from '../../../src/main/tools/info/timers';
import { fileTools, folderKey } from '../../../src/main/tools/files/tools';
import { launchKind } from '../../../src/main/tools/apps/launch';
import { parseAppManifest, parseLibraryFolders } from '../../../src/main/tools/apps/steam';
import { Connectivity } from '../../../src/main/app/connectivity';
import type { AnyTool, ToolContext } from '../../../src/main/tools/types';
import { tempDir } from '../fakes';

const ctx = (approve = true): ToolContext => ({
  activeWindow: null,
  signal: new AbortController().signal,
  confirm: async () => approve,
});
const tool = (tools: AnyTool[], name: string) => tools.find((t) => t.name === name)!;
const run = (t: AnyTool, args: unknown, c = ctx()) => t.run(t.input.parse(args), c);

afterEach(() => {
  vi.useRealTimers();
});

describe('durations', () => {
  it.each([
    ['10 minutes', 600_000],
    ['an hour and a half', 5_400_000],
    ['1.5 hours', 5_400_000],
    ['90 seconds', 90_000],
    ['two minutes 30 seconds', 150_000],
    ['half an hour', 1_800_000],
    ['twenty five minutes', 1_500_000],
    ['1 hour 5 mins', 3_900_000],
    ['a minute', 60_000],
  ])('%s', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it('finds nothing in text without a duration', () => {
    expect(parseDuration('the laundry')).toBeNull();
    expect(parseDuration('5 oclock')).toBeNull();
  });

  it('formats durations for speech', () => {
    expect(formatDuration(90_000)).toBe('1 minute 30 seconds');
    expect(formatDuration(3_600_000)).toBe('1 hour');
    expect(formatDuration(25 * 60_000 + 10_000)).toBe('25 minutes');
  });
});

describe('TimerService', () => {
  it('fires timers, and keeps them across a restart', () => {
    vi.useFakeTimers();
    const file = join(tempDir(), 'timers.json');
    const fired: [Timer, boolean][] = [];
    const service = new TimerService(file, (t, late) => fired.push([t, late]));
    service.start();
    service.add(60_000, 'stretch');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);

    // "Restart": a new service picks the saved timer up.
    service.dispose();
    const again = new TimerService(file, (t, late) => fired.push([t, late]));
    again.start();
    vi.advanceTimersByTime(60_000);
    expect(fired.map(([t, late]) => [t.label, late])).toEqual([['stretch', false]]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('announces a recent timer that went off while closed, and drops old ones', () => {
    const file = join(tempDir(), 'timers.json');
    const now = Date.now();
    writeFileSync(
      file,
      JSON.stringify([
        { id: 'a', label: '', durationMs: 60_000, endsAt: now - 60_000 },
        { id: 'b', label: 'old', durationMs: 60_000, endsAt: now - 3_600_000 },
      ]),
    );
    const fired: [Timer, boolean][] = [];
    new TimerService(file, (t, late) => fired.push([t, late])).start();
    expect(fired.map(([t, late]) => [t.id, late])).toEqual([['a', true]]);
    expect(timerMessage(fired[0]![0], true)).toBe(
      'Your 1 minute timer went off while AI-DA was closed.',
    );
  });

  it('sets, reports and cancels timers through the tools', async () => {
    vi.useFakeTimers();
    const service = new TimerService(join(tempDir(), 't.json'), () => {});
    const tools = timerTools(service);
    expect((await run(tool(tools, 'set_timer'), { duration: '10 minutes' })).speak).toBe(
      'Timer set for 10 minutes.',
    );
    expect(
      (await run(tool(tools, 'set_timer'), { duration: '5 min', label: 'check the oven' })).speak,
    ).toBe("Okay, I'll remind you in 5 minutes.");
    vi.advanceTimersByTime(60_000);
    expect((await run(tool(tools, 'list_timers'), {})).speak).toBe(
      'You have 2 timers. The next one is done in 4 minutes.',
    );
    expect((await run(tool(tools, 'cancel_timer'), { label: 'oven' })).speak).toBe(
      'Timer cancelled.',
    );
    expect((await run(tool(tools, 'list_timers'), {})).speak).toBe('9 minutes left on your timer.');
    expect((await run(tool(tools, 'set_timer'), { duration: 'soon' })).ok).toBe(false);
  });
});

describe('files and folders', () => {
  function setup() {
    const root = tempDir();
    const docs = join(root, 'Documents');
    const downloads = join(root, 'Downloads');
    mkdirSync(join(docs, 'Taxes 2025'), { recursive: true });
    mkdirSync(join(docs, 'node_modules', 'junk'), { recursive: true });
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(docs, 'Taxes 2025', 'Resume final.pdf'), '');
    writeFileSync(join(docs, 'budget.xlsx'), '');
    writeFileSync(join(docs, 'node_modules', 'junk', 'budget.xlsx'), '');
    writeFileSync(join(downloads, 'setup-tool.exe'), '');
    writeFileSync(join(downloads, 'notes.txt'), '');
    writeFileSync(join(docs, 'notes.txt'), '');
    const opened: string[] = [];
    const tools = fileTools({
      knownFolders: { downloads, documents: docs },
      searchRoots: [docs, downloads],
      recentDir: null,
      readShortcut: () => null,
      openPath: async (p) => {
        opened.push(p);
        return '';
      },
    });
    return { tools, opened, docs, downloads };
  }

  it('opens known folders by the names people use', async () => {
    const { tools, opened, downloads } = setup();
    expect((await run(tool(tools, 'open_folder'), { name: 'my Downloads folder' })).speak).toBe(
      'Opening your downloads folder.',
    );
    expect(opened).toEqual([downloads]);
    expect(folderKey('the Taxes folder')).toBe('taxes');
  });

  it('finds folders and files by name, skipping junk folders', async () => {
    const { tools, opened, docs } = setup();
    await run(tool(tools, 'open_folder'), { name: 'taxes 2025' });
    await run(tool(tools, 'open_file'), { name: 'resume final' });
    await run(tool(tools, 'open_file'), { name: 'budget' });
    expect(opened).toEqual([
      join(docs, 'Taxes 2025'),
      join(docs, 'Taxes 2025', 'Resume final.pdf'),
      join(docs, 'budget.xlsx'),
    ]);
  });

  it('asks which one when two files have the same name', async () => {
    const { tools, opened } = setup();
    const result = await run(tool(tools, 'open_file'), { name: 'notes' });
    expect(result).toMatchObject({ ok: false, followUp: true });
    expect(opened).toEqual([]);
  });

  it('asks before running a program', async () => {
    const { tools, opened } = setup();
    const declined = await run(tool(tools, 'open_file'), { name: 'setup tool' }, ctx(false));
    expect(declined.cancelled).toBe(true);
    expect(opened).toEqual([]);
  });
});

describe('Steam and launching', () => {
  it('reads Steam libraries and game manifests', () => {
    const vdf =
      '"libraryfolders" { "0" { "path" "Z:\\\\steam" } "1" { "path" "D:\\\\SteamLibrary" } }';
    expect(parseLibraryFolders(vdf)).toEqual(['Z:\\steam', 'D:\\SteamLibrary']);
    const acf = '"AppState" { "appid" "730" "Universe" "1" "name" "Counter-Strike 2" }';
    expect(parseAppManifest(acf)).toEqual({ appId: '730', name: 'Counter-Strike 2' });
  });

  it('launches game-launcher links as links and everything else from the Apps folder', () => {
    expect(launchKind('steam://rungameid/730')).toBe('link');
    expect(launchKind('com.epicgames.launcher://apps/abc?action=launch')).toBe('link');
    expect(launchKind('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')).toBe('apps-folder');
    expect(launchKind('C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe')).toBe('apps-folder');
    expect(launchKind('file:///C:/evil.exe')).toBe('apps-folder');
  });
});

describe('Connectivity', () => {
  it('goes offline with no network or when the AI stops answering, and back', () => {
    let network = true;
    let now = 0;
    const changes: boolean[] = [];
    const c = new Connectivity(
      () => network,
      (online) => changes.push(online),
      () => now,
    );
    expect(c.online).toBe(true);
    c.providerUnreachable();
    expect(c.online).toBe(false);
    now = 3 * 60_000; // gives the providers another chance after a while
    c.check();
    expect(c.online).toBe(true);
    network = false;
    c.check();
    expect(c.hasNetwork).toBe(false);
    network = true;
    c.providerReached();
    expect(changes).toEqual([false, true, false, true]);
  });
});
