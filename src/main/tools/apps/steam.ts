import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { StartApp } from '../../native/win-host';

/** Installed Steam content that isn't a game you'd ask to open. */
const NOT_A_GAME =
  /redistributable|steamworks|proton|steam linux runtime|soundtrack|dedicated server|\bsdk\b|wallpaper engine|steamvr/i;

/** Library folders from steamapps/libraryfolders.vdf ("path" "D:\\SteamLibrary"). */
export function parseLibraryFolders(vdf: string): string[] {
  return [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1]!.replace(/\\\\/g, '\\'));
}

/** appid and name from a steamapps/appmanifest_<id>.acf file. */
export function parseAppManifest(acf: string): { appId: string; name: string } | null {
  const appId = /"appid"\s+"(\d+)"/.exec(acf)?.[1];
  const name = /"name"\s+"([^"]+)"/.exec(acf)?.[1];
  return appId && name ? { appId, name } : null;
}

/** Steam's install folder from the registry, or null if Steam isn't installed. */
export async function findSteamPath(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(
      'reg.exe',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true, timeout: 5000 },
    );
    return /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Installed Steam games from every library folder, launchable as steam://rungameid/<id>. Covers
 * games that don't have a Start-menu shortcut.
 */
export async function steamGames(steamPath: string | null): Promise<StartApp[]> {
  if (!steamPath) return [];
  let libraries: string[];
  try {
    const vdf = await readFile(join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    libraries = parseLibraryFolders(vdf);
  } catch {
    libraries = [steamPath];
  }
  const games: StartApp[] = [];
  for (const library of libraries) {
    const dir = join(library, 'steamapps');
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const manifest = parseAppManifest(await readFile(join(dir, file), 'utf8'));
        if (manifest && !NOT_A_GAME.test(manifest.name))
          games.push({ name: manifest.name, appId: `steam://rungameid/${manifest.appId}` });
      } catch {
        // Unreadable manifest: skip it.
      }
    }
  }
  return games;
}
