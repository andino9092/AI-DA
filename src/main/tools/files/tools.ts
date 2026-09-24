import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { matchScore } from '../../util/fuzzy';
import { defineTool, type ToolContext } from '../types';

export interface FileDeps {
  /** Folder names people say → paths: downloads, documents, desktop, pictures, music, videos, home. */
  knownFolders: Record<string, string>;
  /** Where to look for files and folders by name (Desktop, Documents, Downloads…). */
  searchRoots: string[];
  /** Windows' Recent items folder (shortcuts to recently opened files), if any. */
  recentDir: string | null;
  /** Target of a .lnk shortcut, or null. */
  readShortcut: (path: string) => string | null;
  /** Opens with the default app; resolves to an error message, or '' on success. */
  openPath: (path: string) => Promise<string>;
}

interface Entry {
  path: string;
  name: string;
  dir: boolean;
  /** Recently opened (from Windows' Recent items): preferred on close scores. */
  recent: boolean;
}

const FOLDER_ALIASES: Record<string, string> = {
  downloads: 'downloads',
  download: 'downloads',
  documents: 'documents',
  document: 'documents',
  docs: 'documents',
  'my documents': 'documents',
  desktop: 'desktop',
  pictures: 'pictures',
  picture: 'pictures',
  photos: 'pictures',
  images: 'pictures',
  music: 'music',
  videos: 'videos',
  video: 'videos',
  movies: 'videos',
  home: 'home',
  'home folder': 'home',
  'user folder': 'home',
  'my files': 'home',
};

/** Programs and scripts: opening one runs it, so the user is asked first. */
const RUNNABLE =
  /^\.(?:exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|cpl|hta|jar|lnk|reg|appref-ms)$/i;
/** Never opened by voice at all. */
const SKIP_DIRS =
  /^(?:node_modules|\.git|appdata|\$recycle\.bin|system volume information|__pycache__|\.venv|venv)$/i;

const MATCH_THRESHOLD = 0.75;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 30_000;
const CACHE_MS = 60_000;

/** Folder name as people say it ("my downloads folder") → alias key or cleaned name. */
export function folderKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^(?:the|my)\s+/, '')
    .replace(/\s+(?:folder|directory)$/, '')
    .trim();
}

export function fileTools(deps: FileDeps) {
  let cache: { at: number; entries: Entry[] } | null = null;

  async function walk(root: string, depth: number, out: Entry[]): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
    let items;
    try {
      items = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= MAX_ENTRIES) return;
      if (item.name.startsWith('.') || item.name.startsWith('~$')) continue;
      const path = join(root, item.name);
      if (item.isDirectory()) {
        if (SKIP_DIRS.test(item.name)) continue;
        out.push({ path, name: item.name, dir: true, recent: false });
        await walk(path, depth + 1, out);
      } else if (item.isFile() && !/\.(?:ini|tmp|lnk)$/i.test(item.name)) {
        out.push({ path, name: item.name, dir: false, recent: false });
      }
    }
  }

  async function recentEntries(): Promise<Entry[]> {
    if (!deps.recentDir) return [];
    let names: string[];
    try {
      names = (await readdir(deps.recentDir)).filter((n) => n.toLowerCase().endsWith('.lnk'));
    } catch {
      return [];
    }
    const entries: Entry[] = [];
    for (const name of names.slice(0, 500)) {
      const target = deps.readShortcut(join(deps.recentDir, name));
      if (!target) continue;
      try {
        const info = await stat(target);
        entries.push({
          path: target,
          name: basename(target),
          dir: info.isDirectory(),
          recent: true,
        });
      } catch {
        // The file was moved or deleted.
      }
    }
    return entries;
  }

  async function entries(): Promise<Entry[]> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.entries;
    const found: Entry[] = await recentEntries();
    for (const root of deps.searchRoots) await walk(root, 1, found);
    cache = { at: Date.now(), entries: found };
    return found;
  }

  /** Best matches for a spoken name, best first. */
  async function search(name: string, dirs: boolean) {
    const wanted = name.trim();
    const hasExt = /\.[a-z0-9]{1,5}$/i.test(wanted);
    const scored = (await entries())
      .filter((e) => e.dir === dirs)
      .map((e) => {
        const bare = e.dir ? e.name : basename(e.name, extname(e.name));
        let score = Math.max(matchScore(wanted, e.name), hasExt ? 0 : matchScore(wanted, bare));
        if (e.recent) score += 0.04;
        return { e, score };
      })
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    // The same file can be found both in Recent and on disk.
    const seen = new Set<string>();
    return scored.filter((s) => {
      const key = s.e.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function open(path: string, what: string) {
    const error = await deps.openPath(path);
    return error
      ? { ok: false, speak: `I couldn't open ${what}: ${error}`, followUp: true }
      : { ok: true, speak: `Opening ${what}.` };
  }

  const describeMatches = (list: { e: Entry }[]) =>
    list.slice(0, 6).map((s) => `${s.e.name} (in ${basename(dirname(s.e.path))})`);

  return [
    defineTool({
      name: 'open_folder',
      description:
        'Open a folder in File Explorer: Downloads, Documents, Desktop, Pictures, Music, Videos, the home folder, or any folder by name.',
      risk: 'safe',
      input: z.object({ name: z.string().min(1).describe('Folder name, e.g. "downloads"') }),
      describe: ({ name }) => `Open the ${folderKey(name)} folder`,
      run: async ({ name }) => {
        const key = folderKey(name);
        const known = FOLDER_ALIASES[key];
        if (known && deps.knownFolders[known])
          return open(
            deps.knownFolders[known]!,
            `your ${known === 'home' ? 'home' : known} folder`,
          );
        const matches = await search(key, true);
        const best = matches[0];
        if (!best || best.score < MATCH_THRESHOLD)
          return {
            ok: false,
            speak: `I couldn't find a folder called ${key}.`,
            data: { similar: describeMatches(matches) },
            followUp: true,
            fromScreen: true,
          };
        return open(best.e.path, best.e.name);
      },
    }),
    defineTool({
      name: 'open_file',
      description:
        'Open a file with its default app, found by name among recent files and in Desktop, Documents and Downloads (e.g. "resume", "budget.xlsx"). Programs and scripts need the user to confirm.',
      risk: 'safe',
      input: z.object({ name: z.string().min(1).describe('File name as the user said it') }),
      describe: ({ name }) => `Open the file ${name}`,
      run: async ({ name }, ctx: ToolContext) => {
        const matches = await search(name, false);
        const best = matches[0];
        if (!best || best.score < MATCH_THRESHOLD)
          return {
            ok: false,
            speak: `I couldn't find a file called ${name}.`,
            data: { similar: describeMatches(matches) },
            followUp: true,
            fromScreen: true,
          };
        // Two different files match about equally well (even with the same name, in different
        // folders): ask which one. A recently opened file scores a bit higher and wins.
        const close = matches.filter((m) => best.score - m.score < 0.03);
        if (close.length > 1)
          return {
            ok: false,
            speak: `I found a few files like that. Which one?`,
            data: { candidates: describeMatches(close) },
            followUp: true,
            fromScreen: true,
          };
        if (RUNNABLE.test(extname(best.e.path)) && !(await ctx.confirm(`Run ${best.e.name}`)))
          return { ok: false, cancelled: true, speak: "Okay, I won't open it." };
        return open(best.e.path, best.e.name);
      },
    }),
  ];
}
