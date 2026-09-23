import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';
import type { OverlayState } from '@shared/voice';

const WIDTH = 560;
const HEIGHT = 64;
const BOTTOM_MARGIN = 24;

/**
 * The small status pill above the taskbar. It never takes focus and ignores the mouse, so it
 * can't get in the way of whatever you're doing.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private hideTimer: NodeJS.Timeout | undefined;
  private last: OverlayState = { phase: 'hidden' };

  constructor(private readonly enabled: () => boolean) {}

  update(state: OverlayState, autoHideMs?: number): void {
    clearTimeout(this.hideTimer);
    if (state.phase === 'hidden' || !this.enabled()) {
      this.hide();
      return;
    }
    this.last = state;
    const win = this.ensureWindow();
    win.webContents.send(IPC.overlayState, state);
    if (!win.isVisible()) {
      this.position(win);
      win.showInactive();
    }
    if (autoHideMs) this.hideTimer = setTimeout(() => this.hide(), autoHideMs);
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.last = { phase: 'hidden' };
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(IPC.overlayState, this.last);
    this.win.hide();
  }

  destroy(): void {
    clearTimeout(this.hideTimer);
    this.win?.destroy();
    this.win = null;
  }

  private position(win: BrowserWindow): void {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height - HEIGHT - BOTTOM_MARGIN),
      width: WIDTH,
      height: HEIGHT,
    });
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    // The first update can arrive before the page has loaded; replay the latest one.
    win.webContents.on('did-finish-load', () => win.webContents.send(IPC.overlayState, this.last));
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) void win.loadURL(`${devUrl}/overlay/index.html`);
    else void win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    this.win = win;
    return win;
  }
}
