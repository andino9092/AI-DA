import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { paths } from './paths';
import { isAllowedExternalUrl } from './external-links';

let win: BrowserWindow | null = null;

export function openSettingsWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    title: 'AI-DA Settings',
    icon: paths.resources('icon.png'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // The settings page never navigates or opens windows; allow-listed links go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(`${devUrl}/settings/index.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings/index.html'));
  }
  return win;
}
