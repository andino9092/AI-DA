import { describe, expect, it } from 'vitest';
import {
  GROUP_NAMES,
  groupOf,
  isSelected,
  moreToolsSpec,
  requestedGroups,
  selectGroups,
} from '../../../src/main/agent/tool-selection';
import { ToolRegistry } from '../../../src/main/tools/registry';
import { appTools } from '../../../src/main/tools/apps/tools';
import { audioTools } from '../../../src/main/tools/system/audio';
import { mediaTools } from '../../../src/main/tools/media/tools';
import { uiTools } from '../../../src/main/tools/ui/tools';
import { windowTools } from '../../../src/main/tools/windows/tools';
import { timeTools } from '../../../src/main/tools/info/time';
import { TimerService, timerTools } from '../../../src/main/tools/info/timers';
import { fileTools } from '../../../src/main/tools/files/tools';
import { WeatherClient, weatherTools } from '../../../src/main/tools/info/weather';
import { unitTools } from '../../../src/main/tools/info/units';
import { spotifyTools } from '../../../src/main/tools/media/spotify';
import { MemoryStore, memoryTools } from '../../../src/main/memory/memory';
import { routineTools } from '../../../src/main/agent/routines';
import { notificationTools } from '../../../src/main/tools/info/notifications';
import { join } from 'node:path';
import { tempDir } from '../fakes';

/** The same tools the app registers (dependencies are never called here). */
function fullRegistry(): ToolRegistry {
  const x = {} as never;
  const dir = tempDir();
  return new ToolRegistry().register(
    ...audioTools(x),
    ...mediaTools({ win: x }),
    ...appTools(x, x, x),
    ...windowTools(x),
    ...uiTools({ win: x, sensitiveApps: () => [] }),
    ...timeTools(),
    ...timerTools(new TimerService(join(dir, 't.json'), () => {})),
    ...fileTools({
      knownFolders: {},
      searchRoots: [],
      recentDir: '',
      readShortcut: () => null,
      openPath: async () => '',
    }),
    ...weatherTools({ client: new WeatherClient(), home: () => null, unit: () => 'celsius' }),
    ...unitTools(),
    ...spotifyTools({ spotify: x, openSpotify: async () => false, hostname: '' }),
    ...memoryTools(new MemoryStore(join(dir, 'm.json'), () => false)),
    ...routineTools({ list: () => [], save: () => {} }),
    ...notificationTools({
      center: x,
      gmail: x,
      calendar: x,
      google: () => ({ connected: false, gmail: true, calendar: true }),
    }),
  );
}

const size = (registry: ToolRegistry, groups: ReturnType<typeof selectGroups>) =>
  JSON.stringify(registry.specs((name) => isSelected(name, groups))).length;

describe('tool selection', () => {
  it('puts every tool the app has in a group', () => {
    const orphans = fullRegistry()
      .list()
      .map((t) => t.name)
      .filter((name) => groupOf(name) === null);
    expect(orphans).toEqual([]);
  });

  it.each([
    ['pause spotify and turn it down a bit', ['apps', 'audio', 'media']],
    ["what's the weather tomorrow", ['info', 'time']],
    ['remind me at 5 to call mom', ['time']],
    ['click the send button in discord', ['apps', 'screen']],
    ['snap this window to the left', ['windows']],
    ['open my downloads folder', ['apps', 'files']],
    ['remember that I like jazz', ['memory']],
    ['create a routine called focus mode', ['routines', 'windows']],
    ['what did I miss', ['notifications']],
    ['do I have any new emails', ['notifications']],
    ["what's on my calendar tomorrow", ['notifications', 'time']],
  ])('"%s" → %j', (text, groups) => {
    expect([...(selectGroups([text]) ?? [])].sort()).toEqual([...groups].sort());
  });

  it('sends everything when no group fits', () => {
    expect(selectGroups(['what is the capital of France'])).toBeNull();
    expect(isSelected('set_volume', null)).toBe(true);
  });

  it('keeps the groups of earlier messages and tools for follow-ups', () => {
    const groups = selectGroups(['set volume to 30', 'and a bit more'], ['open_app']);
    expect([...(groups ?? [])].sort()).toEqual(['apps', 'audio']);
  });

  it('makes a typical request much smaller', () => {
    const registry = fullRegistry();
    const all = size(registry, null);
    const media = size(registry, selectGroups(['skip this song']));
    expect(all).toBeGreaterThan(13_000);
    expect(media).toBeLessThan(all * 0.3);
  });

  it('offers only the missing groups through more_tools', () => {
    const spec = moreToolsSpec(['info', 'files']);
    expect(spec.description).toContain('info (weather and forecast, unit conversion)');
    expect(spec.parameters.properties.groups.items.enum).toEqual(['info', 'files']);
    expect(requestedGroups({ groups: ['info', 'nope'] })).toEqual(['info']);
    expect(requestedGroups({ groups: 'files' })).toEqual(['files']);
    expect(GROUP_NAMES).toContain('memory');
  });
});
