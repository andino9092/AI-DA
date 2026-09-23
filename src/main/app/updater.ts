import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60_000;

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; version: string }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

/**
 * Checks GitHub Releases for a newer AI-DA (installed builds only). Updates download in the
 * background and install on quit, or right away from the tray. Only the version check and the
 * installer download talk to GitHub; nothing about you is sent.
 */
export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private state: UpdateState = { status: 'idle' };

  constructor(
    private readonly enabled: () => boolean,
    private readonly onChange: (state: UpdateState) => void,
  ) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version }),
    );
    autoUpdater.on('update-not-available', () => this.set({ status: 'idle' }));
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'ready', version: info.version }),
    );
    autoUpdater.on('error', (err) =>
      this.set({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }

  get supported(): boolean {
    return app.isPackaged;
  }

  start(): void {
    if (!this.supported || this.timer) return;
    const tick = () => {
      if (this.enabled()) void this.check();
    };
    setTimeout(tick, FIRST_CHECK_DELAY_MS).unref();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref();
  }

  async check(): Promise<void> {
    if (!this.supported || this.state.status === 'ready') return;
    await autoUpdater.checkForUpdates().catch(() => {});
  }

  installNow(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.onChange(state);
  }
}
