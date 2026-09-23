import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';
import type { AssistantEvent } from '@shared/assistant';

const WIDTH = 680;
const HEIGHT = 380;
/** Don't hold up the palette if the Windows helper is still starting. */
const FOREGROUND_TIMEOUT_MS = 250;

/**
 * The command box (Ctrl+Alt+A): a small always-on-top window for typed commands. It remembers
 * which window was in front before it opened, so "snap this left" means that window, not itself.
 */
export class PaletteController {
  private win: BrowserWindow | null = null;
  private activeWindow: number | null = null;
  private holdOpen = 0;

  constructor(private readonly foregroundWindow: () => Promise<number>) {}

  get activeWindowHandle(): number | null {
    return this.activeWindow;
  }

  async toggle(): Promise<void> {
    if (this.win?.isVisible() && this.win.isFocused()) {
      this.hide();
      return;
    }
    this.activeWindow = await Promise.race([
      this.foregroundWindow().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FOREGROUND_TIMEOUT_MS)),
    ]);
    this.show();
  }

  show(): void {
    const win = this.ensureWindow();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    win.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height * 0.18),
      width: WIDTH,
      height: HEIGHT,
    });
    win.show();
    win.focus();
    win.webContents.send(IPC.paletteShown);
  }

  hide(): void {
    this.win?.hide();
  }

  send(event: AssistantEvent): void {
    this.win?.webContents.send(IPC.assistantEvent, event);
  }

  /** Keep the palette open (e.g. while a confirmation is waiting) even if it loses focus. */
  hold(): () => void {
    this.holdOpen++;
    let released = false;
    return () => {
      if (!released) this.holdOpen--;
      released = true;
    };
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
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'AI-DA',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('blur', () => {
      if (this.holdOpen === 0) win.hide();
    });
    win.on('closed', () => {
      this.win = null;
    });

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) void win.loadURL(`${devUrl}/palette/index.html`);
    else void win.loadFile(join(__dirname, '../renderer/palette/index.html'));

    this.win = win;
    return win;
  }
}
