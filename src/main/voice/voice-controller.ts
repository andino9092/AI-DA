import { randomUUID } from 'node:crypto';
import type { AssistantState } from '@shared/assistant';
import type {
  AudioCommand,
  AudioEvent,
  HeardEvent,
  ListenMode,
  OverlayState,
  Utterance,
  WakeSensitivity,
} from '@shared/voice';
import { STT_SAMPLE_RATE, type SpeechToText } from './stt';
import { peakDbfs } from './wav';
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
    sensitivity: WakeSensitivity;
  };
  /** Settings → Mic check is open: keep the mic on and report what's heard. */
  monitoring: () => boolean;
  onHeard: (heard: HeardEvent) => void;
  /** Ready to listen (VAD + speech recognition installed) / ready to talk (voice installed). */
  canListen: () => boolean;
  canSpeak: () => boolean;
}

/** "Hey Aida, stop" and friends interrupt instead of being sent to the assistant. */
const STOP_WORDS =
  /^(?:stop|cancel|never ?mind|be quiet|quiet|shut up|shush|that's enough|enough)[.!]*$/i;

const REPLY_VISIBLE_MS = 4000;
/** Holding push-to-talk at least this long means "listen until I let go". */
const HOLD_MS = 350;

const YES =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|do it|go ahead|confirm(?:ed)?|please do|affirmative|correct|send it)\b/i;
const NO = /^(?:no|nope|nah|cancel|stop|don'?t|do not|never ?mind|wait)\b/i;

/** "Yes" → true, "No" → false, anything else → null (treated as no). */
export function parseYesNo(text: string): boolean | null {
  const t = text.trim().replace(/^(?:uh|um|hmm|well)[,.]?\s+/i, '');
  if (NO.test(t)) return false;
  if (YES.test(t)) return true;
  return null;
}

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
  /** Push-to-talk key is down (hold-to-talk). */
  private holding: { since: number } | null = null;
  /** Waiting for a spoken yes/no. */
  private confirming: { question: string; resolve: (approved: boolean) => void } | null = null;
  /** Runs when the current speech finishes playing, instead of the usual follow-up. */
  private afterSpeech: (() => void) | null = null;
  /** Bumped by panic so a command that was running doesn't speak its reply afterwards. */
  private generation = 0;

  constructor(private readonly deps: VoiceDeps) {}

  /** Re-applies mic mode after settings change (mute, wake word on/off, device). */
  refresh(): void {
    const { deviceId, sensitivity } = this.deps.settings();
    this.deps.audio({
      type: 'config',
      mode: this.listenMode(),
      deviceId,
      sensitivity,
      meter: this.deps.monitoring(),
      hold: this.holding !== null,
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

  /** Hold-to-talk: key down starts listening; key up ends the command if it was held. */
  pushToTalkDown(): void {
    this.holding = { since: Date.now() };
    this.pushToTalk();
    if (this.phase !== 'command') this.holding = null;
    else this.refresh();
  }

  pushToTalkUp(): void {
    const held = this.holding;
    this.holding = null;
    if (!held || this.phase !== 'command') return;
    this.refresh();
    if (Date.now() - held.since >= HOLD_MS) this.deps.audio({ type: 'flush' });
  }

  /**
   * Asks a yes/no question out loud and listens for the answer (no wake word needed). Returns
   * null when voice can't be used, so the caller can show an on-screen card instead.
   */
  confirm(summary: string): Promise<boolean> | null {
    if (!this.deps.canListen() || !this.deps.settings().listening) return null;
    this.confirming?.resolve(false);
    const question = `${summary.replace(/[.?!]+$/, '')}?`;
    return new Promise<boolean>((resolve) => {
      this.confirming = {
        question,
        resolve: (approved) => {
          this.confirming = null;
          resolve(approved);
        },
      };
      const listen = () => {
        if (!this.confirming) return;
        this.phase = 'command';
        this.deps.audio({ type: 'chime', chime: 'listen' });
        this.deps.setState('listening');
        this.deps.overlay({ phase: 'confirm', text: `${question} Say yes or no.` });
        this.refresh();
      };
      this.deps.overlay({ phase: 'confirm', text: `${question} Say yes or no.` });
      if (this.deps.settings().speakReplies && this.deps.canSpeak()) {
        this.afterSpeech = listen;
        void this.say(question).catch(() => listen());
      } else listen();
    });
  }

  /** Panic: stop talking, decline anything waiting for an answer, go back to idle. */
  panic(): void {
    this.generation++;
    this.holding = null;
    this.afterSpeech = null;
    this.confirming?.resolve(false);
    this.stopSpeaking();
    this.deps.audio({ type: 'chime', chime: 'done' });
    this.toIdle(true);
    this.deps.overlay({ phase: 'reply', text: 'Stopped.' }, 2000);
  }

  stopSpeaking(): void {
    this.afterSpeech = null;
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
        if (this.confirming) this.answer(false);
        else if (this.phase === 'command') this.toIdle();
        break;
      case 'playback-finished':
        if (this.speech?.id === event.id) {
          this.speech = null;
          const next = this.afterSpeech;
          this.afterSpeech = null;
          if (next) next();
          else if (this.phase === 'speaking') this.afterSpeaking();
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
    // The answer to a confirmation can't wait in line: the command that asked is still running.
    if (this.confirming && (utterance.mode === 'command' || this.phase === 'command')) {
      void this.handleAnswer(utterance);
      return;
    }
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

    const wake = expectingCommand ? null : matchWakePhrase(text, { fuzzy: this.fuzzy() });
    // The mic check can run with the wake word off: report what was heard, but don't act on it.
    const actOnWake = this.deps.settings().wakeWord;
    if (this.deps.monitoring())
      this.deps.onHeard({
        text,
        mode: expectingCommand ? 'command' : 'wake',
        accepted: expectingCommand ? text !== '' : wake !== null && actOnWake,
        peakDb: Math.round(peakDbfs(samples)),
        seconds: Math.round((samples.length / STT_SAMPLE_RATE) * 10) / 10,
      });

    let command: string;
    if (expectingCommand) {
      command = text;
      if (!command) {
        this.deps.overlay({ phase: 'error', text: "Sorry, I didn't catch that." }, 2500);
        this.toIdle(true);
        return;
      }
    } else {
      if (!wake || !actOnWake) return; // Not for us: dropped without logging.
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

  private async handleAnswer({ samples }: Utterance): Promise<void> {
    this.deps.overlay({ phase: 'transcribing' });
    const text = await this.deps.stt.transcribe(samples).catch(() => '');
    this.answer(parseYesNo(text) === true);
  }

  private answer(approved: boolean): void {
    if (!this.confirming) return;
    this.confirming.resolve(approved);
    // Back to the command that asked.
    this.phase = 'processing';
    this.deps.setState('thinking');
    this.deps.overlay({ phase: 'thinking' });
    this.refresh();
  }

  /** Speaks text, resolving once it has been handed to the speakers. */
  private async say(text: string): Promise<void> {
    const id = randomUUID();
    const abort = new AbortController();
    this.speech = { id, abort };
    this.deps.setState('speaking');
    await this.deps.speak(
      text,
      (samples, sampleRate) => this.deps.audio({ type: 'play', id, samples, sampleRate }),
      abort.signal,
    );
    this.deps.audio({ type: 'end-of-speech', id });
  }

  private async run(command: string): Promise<void> {
    this.phase = 'processing';
    this.refresh();
    this.deps.setState('thinking');
    this.deps.overlay({ phase: 'thinking', text: command });

    const generation = this.generation;
    const activeWindow = await this.deps.foregroundWindow().catch(() => null);
    const reply = await this.deps.handleCommand(command, activeWindow);
    if (generation !== this.generation) return;
    this.lastReply = reply;

    const { speakReplies } = this.deps.settings();
    if (!speakReplies || !this.deps.canSpeak() || !reply) {
      this.deps.overlay({ phase: 'reply', text: reply }, REPLY_VISIBLE_MS);
      this.followUpOrIdle(reply);
      return;
    }

    this.phase = 'speaking';
    this.deps.overlay({ phase: 'speaking', text: reply });
    try {
      await this.say(reply);
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

  private fuzzy(): boolean {
    return this.deps.settings().sensitivity !== 'low';
  }

  private listenMode(): ListenMode {
    const { listening, wakeWord } = this.deps.settings();
    if (!listening || !this.deps.canListen()) return 'off';
    if (this.phase === 'command') return 'command';
    // While a command runs, only a confirmation answer or push-to-talk is listened for.
    return wakeWord || this.deps.monitoring() ? 'wake' : 'off';
  }
}
