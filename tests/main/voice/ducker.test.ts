import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ducker } from '../../../src/main/voice/ducker';
import { FakeWindows, tempDir } from '../fakes';

function setup(enabled = true) {
  const win = new FakeWindows();
  win.appVolumes = [
    { process: 'Spotify', level: 80, muted: false },
    { process: 'zen', level: 50, muted: false },
    { process: 'electron', level: 100, muted: false },
    { process: 'Discord', level: 60, muted: true },
  ];
  const stateFile = join(tempDir(), 'ducked.json');
  const ducker = new Ducker(win, { enabled: () => enabled, ownProcess: 'electron', stateFile });
  const levels = () => Object.fromEntries(win.appVolumes.map((a) => [a.process, a.level]));
  return { win, ducker, stateFile, levels };
}

describe('Ducker', () => {
  it('turns other apps down and puts them back, leaving AI-DA and muted apps alone', async () => {
    const { ducker, levels, stateFile } = setup();
    await ducker.set(true);
    expect(levels()).toEqual({ Spotify: 24, zen: 15, electron: 100, Discord: 60 });
    expect(existsSync(stateFile)).toBe(true);
    await ducker.set(true); // already down: nothing changes
    expect(levels().Spotify).toBe(24);
    await ducker.set(false);
    expect(levels()).toEqual({ Spotify: 80, zen: 50, electron: 100, Discord: 60 });
    expect(existsSync(stateFile)).toBe(false);
  });

  it("keeps the user's own change made while ducked", async () => {
    const { win, ducker, levels } = setup();
    await ducker.set(true);
    win.appVolumes.find((a) => a.process === 'Spotify')!.level = 40;
    await ducker.set(false);
    expect(levels()).toMatchObject({ Spotify: 40, zen: 50 });
  });

  it('does nothing when turned off in settings', async () => {
    const { ducker, levels } = setup(false);
    await ducker.set(true);
    expect(levels().Spotify).toBe(80);
  });

  it('restores levels left lowered by a run that quit early', async () => {
    const { win, stateFile, levels } = setup();
    writeFileSync(stateFile, JSON.stringify({ Spotify: { original: 90, ducked: 27 } }));
    win.appVolumes[0]!.level = 27;
    const ducker = new Ducker(win, { enabled: () => true, ownProcess: 'electron', stateFile });
    await ducker.recover();
    expect(levels().Spotify).toBe(90);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("remembers apps that weren't running when restoring, for next time", async () => {
    const { win, ducker, stateFile } = setup();
    await ducker.set(true);
    win.appVolumes = win.appVolumes.filter((a) => a.process !== 'zen');
    await ducker.set(false);
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({
      zen: { original: 50, ducked: 15 },
    });
  });
});
