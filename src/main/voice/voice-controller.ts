import { randomUUID } from 'node:crypto';
import type { AssistantState } from '@shared/assistant';
import type { AudioCommand, AudioEvent, ListenMode, OverlayState, Utterance } from '@shared/voice';
import type { SpeechToText } from './stt';
import { matchWakePhrase } from './wake-phrase';

export interface VoiceDeps {
  stt: SpeechToText;
  speak: (
    text: string,
    onChunk: (samples: Float32Array, rate: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  handleCommand: (text: string, activeWindow: number | null) => Promise<string>;
  foregroundWindow: () => Promise<number | null>;
  audio: (command: AudioCommand) => void;
  overlay: (state: OverlayState, autoHideMs?: number) => void;
  setState: (state: AssistantState | null) => void;
  settings: () => {
    listening: boolean;
    wakeWord: boolean;
    speakReplies: boolean;
    deviceId: string | null;
  };
  /** Ready to listen (VAD + speech recognition installed) / ready to talk (voice installed). */
  canListen: () => boolean;
  canSpeak: () => boolean;
}

/** "Hey Aida, stop" and friends interrupt instead of being sent to the assistant. */
const STOP_WORDS =
  /^(?:stop|cancel|never ?mind|be quiet|quiet|shut up|shush|that's enough|enough)[.!]*$/i;

const REPLY_VISIBLE_MS = 4000;

/**
 * The voice loop: wake phrase / push-to-talk → local transcription → assistant → spoken reply.
 * Speech that doesn't start with the wake phrase is transcribed locally, then dropped and never
 * logged or sent anywhere.
 */
export class VoiceController {
  private phase: 'idle' | 'command' | 'processing' | 'speaking' = 'idle';
  private speech: { id: string; abort: AbortController } | null = null;
  private lastReply = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VoiceDeps) {}

  /** Re-applies mic mode after settings change (mute, wake word on/off, device). */
  refresh(): void {
    this.deps.audio({
      type: 'config',
      mode: this.listenMode(),
      deviceId: this.deps.settings().deviceId,
    });
  }

  /** Push-to-talk: stop talking if needed, then listen for a command right away. */
  pushToTalk(): void {
    if (!this.deps.canListen()) {
      this.deps.overlay(
        { phase: 'error', text: "Voice isn't set up yet. Open Settings → Voice." },
        REPLY_VISIBLE_MS,
      );
      return;
    }
    this.stopSpeaking();
    this.armCommand();
  }

  stopSpeaking(): void {
    if (!this.speech) return;
    this.speech.abort.abort();
    this.speech = null;
    this.deps.audio({ type: 'stop-playback' });
    if (this.phase === 'speaking') this.toIdle();
  }

  onAudioEvent(event: AudioEvent): void {
    switch (event.type) {
      case 'ready':
        this.refresh();
        break;
      case 'speech-start':
        if (event.mode === 'command') this.deps.overlay({ phase: 'listening' });
        break;
      case 'level':
        if (this.phase === 'command') this.deps.overlay({ phase: 'listening', level: event.rms });
        break;
      case 'command-timeout':
        if (this.phase === 'command') this.toIdle();
        break;
      case 'playback-finished':
        if (this.speech?.id === event.id) {
          this.speech = null;
          if (this.phase === 'speaking') this.afterSpeaking();
        }
        break;
      case 'mic-state':
        if (event.error)
          this.deps.overlay(
            { phase: 'error', text: `Microphone: ${event.error}` },
            REPLY_VISIBLE_MS,
          );
        break;
      case 'error':
        this.deps.overlay({ phase: 'error', text: event.message }, REPLY_VISIBLE_MS);
        break;
    }
  }

  onUtterance(utterance: Utterance): void {
    // One utterance at a time, in order.
    this.queue = this.queue.then(() => this.process(utterance)).catch(() => {});
  }

  /** Waits for queued utterances (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async process({ mode, samples }: Utterance): Promise<void> {
    if (mode === 'wake' && this.phase === 'processing') return;
    const expectingCommand = mode === 'command' || this.phase === 'command';
    if (expectingCommand) this.deps.overlay({ phase: 'transcribing' });

    let text: string;
    try {
      text = await this.deps.stt.transcribe(samples);
    } catch (err) {
      if (expectingCommand) this.fail(err instanceof Error ? err.message : String(err));
      return;
    }

    let command: string;
    if (expectingCommand) {
      command = text;
      if (!command) {
        this.deps.overlay({ phase: 'error', text: "Sorry, I didn't catch that." }, 2500);
        this.toIdle(true);
        return;
      }
    } else {
      const wake = matchWakePhrase(text);
      if (!wake) return; // Not for us: dropped without logging.
      if (!wake.command) {
        this.stopSpeaking();
        this.armCommand();
        return;
      }
      command = wake.command;
    }

    if (STOP_WORDS.test(command.trim())) {
      this.stopSpeaking();
      this.deps.audio({ type: 'chime', chime: 'done' });
      this.toIdle();
      return;
    }

    this.stopSpeaking();
    await this.run(command);
  }

  private async run(command: string): Promise<void> {
    this.phase = 'processing';
    this.refresh();
    this.deps.setState('thinking');
    this.deps.overlay({ phase: 'thinking', text: command });

    const activeWindow = await this.deps.foregroundWindow().catch(() => null);
    const reply = await this.deps.handleCommand(command, activeWindow);
    this.lastReply = reply;

    const { speakReplies } = this.deps.settings();
    if (!speakReplies || !this.deps.canSpeak() || !reply) {
      this.deps.overlay({ phase: 'reply', text: reply }, REPLY_VISIBLE_MS);
      this.followUpOrIdle(reply);
      return;
    }

    const id = randomUUID();
    const abort = new AbortController();
    this.speech = { id, abort };
    this.phase = 'speaking';
    this.deps.setState('speaking');
    this.deps.overlay({ phase: 'speaking', text: reply });
    try {
      await this.deps.speak(
        reply,
        (samples, sampleRate) => this.deps.audio({ type: 'play', id, samples, sampleRate }),
        abort.signal,
      );
      this.deps.audio({ type: 'end-of-speech', id });
    } catch {
      // Speaking failed: the reply is still on screen.
      this.speech = null;
      this.deps.overlay({ phase: 'reply', text: reply }, REPLY_VISIBLE_MS);
      this.followUpOrIdle(reply);
    }
  }

  private afterSpeaking(): void {
    this.deps.overlay({ phase: 'reply', text: this.lastReply }, 1500);
    this.followUpOrIdle(this.lastReply);
  }

  /** A question from Aida ("Which one?") opens the mic for the answer without the wake phrase. */
  private followUpOrIdle(reply: string): void {
    if (/\?\s*$/.test(reply) && this.deps.canListen() && this.deps.settings().listening)
      this.armCommand();
    else this.toIdle(true);
  }

  private armCommand(): void {
    this.phase = 'command';
    this.deps.audio({ type: 'chime', chime: 'listen' });
    this.deps.setState('listening');
    this.deps.overlay({ phase: 'listening' });
    this.refresh();
  }

  /** keepOverlay: a reply or error was just shown and hides itself after a moment. */
  private toIdle(keepOverlay = false): void {
    this.phase = 'idle';
    this.deps.setState(null);
    this.refresh();
    if (!keepOverlay && !this.speech) this.deps.overlay({ phase: 'hidden' });
  }

  private fail(message: string): void {
    this.deps.audio({ type: 'chime', chime: 'error' });
    this.deps.overlay({ phase: 'error', text: message }, REPLY_VISIBLE_MS);
    this.toIdle(true);
  }

  private listenMode(): ListenMode {
    const { listening, wakeWord } = this.deps.settings();
    if (!listening || !this.deps.canListen()) return 'off';
    if (this.phase === 'command') return 'command';
    return wakeWord ? 'wake' : 'off';
  }
}
