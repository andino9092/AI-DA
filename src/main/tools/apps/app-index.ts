import type { StartApp, WindowsBridge } from '../../native/win-host';
import { rankByName, type Ranked } from '../../util/fuzzy';

/** Start-menu entries that are never what someone means by "open X". */
const JUNK =
  /\b(uninstall|uninstaller|readme|read me|help|documentation|manual|release notes|website|license|changelog|support|faq)\b/i;

/** Common spoken names that don't fuzzy-match their real app name. */
const ALIASES: Record<string, string> = {
  'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code',
  code: 'Visual Studio Code',
  browser: 'Microsoft Edge',
  edge: 'Microsoft Edge',
  explorer: 'File Explorer',
  files: 'File Explorer',
  'file manager': 'File Explorer',
  terminal: 'Terminal',
  cmd: 'Command Prompt',
  'command line': 'Command Prompt',
  settings: 'Settings',
  'control panel': 'Control Panel',
  calculator: 'Calculator',
  notes: 'Notepad',
  'task manager': 'Task Manager',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
};

export const APP_MATCH_THRESHOLD = 0.6;
const REFRESH_MS = 10 * 60 * 1000;

export class AppIndex {
  private apps: StartApp[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly bridge: Pick<WindowsBridge, 'listStartApps'>) {}

  /** Loads the Start menu in the background; results are cached for ten minutes. */
  refresh(force = false): Promise<void> {
    if (!force && this.apps.length && Date.now() - this.loadedAt < REFRESH_MS)
      return Promise.resolve();
    this.loading ??= this.bridge
      .listStartApps()
      .then((apps) => {
        this.apps = apps.filter((a) => a.name && a.appId && !JUNK.test(a.name));
        this.loadedAt = Date.now();
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async search(query: string, limit = 5): Promise<Ranked<StartApp>[]> {
    await this.refresh();
    const alias = ALIASES[query.trim().toLowerCase()];
    const ranked = rankByName(alias ?? query, this.apps, (a) => a.name);
    // Prefer shorter names on ties ("Spotify" over "Spotify Widget").
    ranked.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
    return ranked.slice(0, limit);
  }

  async best(query: string): Promise<StartApp | null> {
    const [top] = await this.search(query, 1);
    return top && top.score >= APP_MATCH_THRESHOLD ? top.item : null;
  }
}
