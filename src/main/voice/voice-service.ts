import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { AssistantState } from '@shared/assistant';
import { IPC } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { MonitorEvent } from '@shared/voice';
import { AudioWindow } from '../app/audio-window';
import { OverlayWindow } from '../app/overlay-window';
import type { ModelManager } from '../models/model-manager';
import { WhisperServer } from './stt';
import { TtsService } from './tts';
import { VoiceController } from './voice-controller';

export interface VoiceServiceDeps {
  settings: () => Settings;
  models: ModelManager;
  handleCommand: (text: string, activeWindow: number | null) => Promise<string>;
  foregroundWindow: () => Promise<number | null>;
  setState: (state: AssistantState | null) => void;
}

const WAKE_PROMPT = 'Hey Aida,';

/** Builds and runs the whole local voice stack: audio window, Whisper, Kokoro, overlay. */
export class VoiceService {
  readonly audio: AudioWindow;
  private readonly overlay: OverlayWindow;
  private readonly tts: TtsService;
  private stt: WhisperServer | null = null;
  private readonly controller: VoiceController;
  /** The Settings window while its mic check is open. */
  private monitor: WebContents | null = null;

  constructor(private readonly deps: VoiceServiceDeps) {
    const { models, settings } = deps;
    this.overlay = new OverlayWindow(() => settings().voice.showOverlay);
    this.tts = new TtsService(join(__dirname, 'tts-worker.js'), () => models.path(''));
    this.controller = new VoiceController({
      stt: { transcribe: (samples, signal) => this.requireStt().transcribe(samples, signal) },
      speak: (text, onChunk, signal) => {
        const { voice, speed } = settings().voice;
        return this.tts.speak(text, { voice, speed }, onChunk, signal);
      },
      handleCommand: deps.handleCommand,
      foregroundWindow: deps.foregroundWindow,
      audio: (command) => this.audio.send(command),
      overlay: (state, autoHideMs) => this.overlay.update(state, autoHideMs),
      setState: deps.setState,
      settings: () => {
        const s = settings();
        return {
          listening: !s.microphoneMuted,
          wakeWord: s.voice.wakeWord,
          speakReplies: s.voice.speakReplies,
          deviceId: s.voice.inputDeviceId,
          sensitivity: s.voice.wakeSensitivity,
        };
      },
      monitoring: () => this.monitor !== null,
      onHeard: (heard) => this.sendMonitor({ type: 'heard', heard }),
      canListen: () => this.canListen(),
      canSpeak: () => models.isReady('kokoro'),
    });
    this.audio = new AudioWindow({
      onEvent: (event) => {
        if (event.type === 'level') this.sendMonitor({ type: 'level', rms: event.rms });
        this.controller.onAudioEvent(event);
      },
      onUtterance: (utterance) => this.controller.onUtterance(utterance),
    });
  }

  canListen(): boolean {
    const { models } = this.deps;
    return (
      models.isReady('vad') && models.isReady('whisper-runtime') && models.isReady('whisper-model')
    );
  }

  /** Starts whatever is installed; safe to call again after models finish downloading. */
  start(): void {
    const { models } = this.deps;
    if (models.isReady('vad') || models.isReady('kokoro')) this.audio.start();
    if (this.canListen() && !this.stt) {
      this.stt = new WhisperServer({
        exePath: models.path('whisper/runtime/Release/whisper-server.exe'),
        modelPath: models.path('whisper/ggml-large-v3-turbo-q5_0.bin'),
        language: 'en',
        prompt: WAKE_PROMPT,
      });
      // Warm up now so the first command isn't slowed by loading the model.
      void this.stt
        .start()
        .catch((err: unknown) => console.error('[AI-DA] speech recognition:', err));
    }
    if (models.isReady('kokoro'))
      void this.tts
        .start()
        .then(() => {
          const { voice, speed } = this.deps.settings().voice;
          return this.tts.prewarm({ voice, speed });
        })
        .catch((err: unknown) => console.error('[AI-DA] voice:', err));
    this.controller.refresh();
  }

  refresh(): void {
    this.controller.refresh();
  }

  pushToTalk(): void {
    this.controller.pushToTalk();
  }

  pushToTalkDown(): void {
    this.controller.pushToTalkDown();
  }

  pushToTalkUp(): void {
    this.controller.pushToTalkUp();
  }

  /** Spoken yes/no for a voice command's confirmation; null if voice isn't available. */
  confirm(summary: string): Promise<boolean> | null {
    return this.controller.confirm(summary);
  }

  panic(): void {
    this.controller.panic();
  }

  async vadModel(): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.deps.models.path('vad/silero_vad.onnx')));
  }

  /**
   * Settings → Mic check: while open, the mic stays on and that window sees the live level and
   * what the wake-phrase check heard. Stops when the window closes.
   */
  setMonitor(target: WebContents | null): void {
    if (target === this.monitor) return;
    this.monitor = target;
    target?.once('destroyed', () => {
      if (this.monitor === target) this.setMonitor(null);
    });
    this.controller.refresh();
  }

  private sendMonitor(event: MonitorEvent): void {
    if (this.monitor && !this.monitor.isDestroyed())
      this.monitor.send(IPC.voiceMonitorEvent, event);
  }

  /** Settings → "Test voice". */
  async test(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.models.isReady('kokoro'))
      return { ok: false, error: 'Download the voice first.' };
    const { voice, speed } = this.deps.settings().voice;
    const id = randomUUID();
    try {
      await this.tts.speak(
        "Hi, I'm Aida. This is how I sound.",
        { voice, speed },
        (samples, sampleRate) => this.audio.send({ type: 'play', id, samples, sampleRate }),
      );
      this.audio.send({ type: 'end-of-speech', id });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  dispose(): void {
    this.stt?.stop();
    this.tts.stop();
    this.audio.destroy();
    this.overlay.destroy();
  }

  private requireStt(): WhisperServer {
    if (!this.stt) throw new Error('Speech recognition is not installed yet.');
    return this.stt;
  }
}
