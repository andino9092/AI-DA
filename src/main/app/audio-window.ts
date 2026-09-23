import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import type { AudioCommand, AudioEvent, Utterance } from '@shared/voice';

/** Longest utterance accepted from the audio window (20 s at 16 kHz). */
const MAX_SAMPLES = 16_000 * 20;

const utteranceSchema = z.object({
  mode: z.enum(['off', 'wake', 'command']),
  samples: z.instanceof(Float32Array).refine((s) => s.length > 0 && s.length <= MAX_SAMPLES),
});

/**
 * The hidden window that owns the microphone and speakers. It is the only page allowed to open
 * the microphone, and only its messages are accepted as audio.
 */
export class AudioWindow {
  private win: BrowserWindow | null = null;
  private ready = false;
  private config: Extract<AudioCommand, { type: 'config' }> | null = null;

  constructor(
    private readonly handlers: {
      onEvent: (event: AudioEvent) => void;
      onUtterance: (utterance: Utterance) => void;
    },
  ) {
    ipcMain.on(IPC.voiceEvent, (event, payload: AudioEvent) => {
      if (!this.isAudioSender(event)) return;
      if (payload.type === 'ready') {
        this.ready = true;
        if (this.config) this.send(this.config);
      }
      this.handlers.onEvent(payload);
    });
    ipcMain.on(IPC.voiceUtterance, (event, payload: unknown) => {
      if (!this.isAudioSender(event)) return;
      const parsed = utteranceSchema.safeParse(payload);
      if (parsed.success) this.handlers.onUtterance(parsed.data);
    });
  }

  get webContentsId(): number | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents.id : null;
  }

  start(): void {
    if (this.win && !this.win.isDestroyed()) return;
    this.ready = false;
    const win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Hidden windows are throttled by default; audio timing must not be.
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', () => {
      this.win = null;
      this.ready = false;
      setTimeout(() => this.start(), 1000);
    });
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) void win.loadURL(`${devUrl}/audio/index.html`);
    else void win.loadFile(join(__dirname, '../renderer/audio/index.html'));
    this.win = win;
  }

  send(command: AudioCommand): void {
    if (command.type === 'config') this.config = command;
    if (!this.ready || !this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(IPC.voiceCommand, command);
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }

  private isAudioSender(event: IpcMainEvent): boolean {
    return this.webContentsId !== null && event.sender.id === this.webContentsId;
  }
}
