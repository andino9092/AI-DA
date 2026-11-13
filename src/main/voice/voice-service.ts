import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { AssistantState } from '@shared/assistant';
import { IPC } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { AudioCommand, MonitorEvent, VoiceIdResult, VoiceIdStatus } from '@shared/voice';
import { AudioWindow } from '../app/audio-window';
import { OverlayWindow } from '../app/overlay-window';
import type { ModelManager } from '../models/model-manager';
import { WhisperServer } from './stt';
import { TtsService } from './tts';
import { cpuEngine, gpuEngine } from './tts-engines';
import { AecCapture } from './aec-capture';
import {
  addToVoiceprint,
  embed,
  enrollmentConsistency,
  loadSpeakerModel,
  makeVoiceprint,
  MIN_SPEECH_SAMPLES,
  voiceMatch,
  type EmbeddingModel,
  type Voiceprint,
  type VoiceprintStore,
} from './speaker-id';
import type { TtsResponse } from '@shared/tts-protocol';
import type { Trace, Tracer } from '../trace/tracer';
import type { VoiceDiagnostic } from './diagnostics';
import { VoiceController } from './voice-controller';

export interface VoiceServiceDeps {
  settings: () => Settings;
  models: ModelManager;
  handleCommand: (text: string, activeWindow: number | null, trace?: Trace) => Promise<string>;
  tracer?: Tracer;
  /** Receives what became of each utterance; the caller decides whether to keep it. */
  diagnose?: (diagnostic: VoiceDiagnostic) => void;
  foregroundWindow: () => Promise<number | null>;
  setState: (state: AssistantState | null) => void;
  duck: (on: boolean) => void;
  /** aida-win.exe, which also runs Windows' echo canceller for the microphone. */
  helperExe: string;
  /** The owner's encrypted voiceprint, for "Only respond to my voice". */
  voiceprints: VoiceprintStore;
}

/** Recordings in one enrollment: enough to average out one odd sample. */
const ENROLL_SAMPLES = 5;
const ENROLL_MINIMUM = 3;
/** Extra recordings made with sound playing, added to an existing voiceprint. */
const ADD_SAMPLES = 3;
/**
 * While voice samples are being recorded, "Hey Aida" isn't acted on: the samples are real
 * commands said out loud. It ends with Save or Cancel, or by itself this long after the last
 * recording, so a session that was walked away from can't leave Aida deaf.
 */
const ENROLL_QUIET_MS = 30_000;

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
  /** Receivers of the graphics-card voice engine's messages. */
  private readonly ttsListeners = new Set<(message: TtsResponse) => void>();
  /** Windows' echo canceller for the mic; off for the session if it can't run here. */
  private readonly aec: AecCapture;
  private aecFailed: string | null = null;
  private voiceprint: Voiceprint | null;
  private speakerModelLoad: Promise<EmbeddingModel> | null = null;
  /** Fingerprints recorded so far in Settings, before they're saved. */
  private enrollment: Float32Array[] = [];
  /** The session adds to the saved voiceprint (recorded over sound) instead of replacing it. */
  private adding = false;
  /** Voice samples are being recorded until this time (see ENROLL_QUIET_MS). */
  private enrollingUntil = 0;

  constructor(private readonly deps: VoiceServiceDeps) {
    const { models, settings } = deps;
    this.voiceprint = deps.voiceprints.load();
    this.overlay = new OverlayWindow(() => settings().voice.showOverlay);
    // The graphics card first (2.5–3× faster), the CPU if it can't start.
    this.tts = new TtsService(
      [
        gpuEngine(
          // The audio window is created below; these only run once it exists.
          {
            send: (command) => this.audio.send(command),
            onPageGone: (listener) => this.audio.onPageGone(listener),
          },
          (listener) => {
            this.ttsListeners.add(listener);
            return () => this.ttsListeners.delete(listener);
          },
        ),
        cpuEngine(join(__dirname, 'tts-worker.js')),
      ],
      () => models.path(''),
      (message) => console.log(`[AI-DA] ${message}`),
    );
    this.controller = new VoiceController({
      stt: { transcribe: (samples, signal) => this.requireStt().transcribe(samples, signal) },
      speak: (text, onChunk, signal) => {
        const { voice, speed } = settings().voice;
        return this.tts.speak(text, { voice, speed }, onChunk, signal);
      },
      handleCommand: deps.handleCommand,
      tracer: deps.tracer,
      diagnose: deps.diagnose,
      foregroundWindow: deps.foregroundWindow,
      audio: (command) =>
        this.audio.send(command.type === 'config' ? this.withMicSource(command) : command),
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
      paused: () => Date.now() < this.enrollingUntil,
      onHeard: (heard) => this.sendMonitor({ type: 'heard', heard }),
      canListen: () => this.canListen(),
      canSpeak: () => models.isReady('kokoro'),
      duck: deps.duck,
      speaker: {
        enabled: () =>
          settings().voice.onlyMyVoice && this.voiceprint !== null && models.isReady('speaker'),
        match: async (samples) => {
          if (!this.voiceprint || samples.length < MIN_SPEECH_SAMPLES) return null;
          return voiceMatch(this.voiceprint, await embed(await this.speakerModel(), samples));
        },
      },
    });
    this.aec = new AecCapture(deps.helperExe, {
      onAudio: (samples) => this.audio.send({ type: 'mic-audio', samples }),
      onStarted: () => console.log('[AI-DA] microphone: Windows echo cancellation on'),
      onFailed: (reason) => {
        // Fall back to the browser microphone for the rest of the session.
        console.error(`[AI-DA] echo cancellation unavailable: ${reason}`);
        this.aecFailed = reason;
        this.controller.refresh();
      },
    });
    this.audio = new AudioWindow({
      onEvent: (event) => {
        if (event.type === 'tts') {
          for (const listener of this.ttsListeners) listener(event.response);
          return;
        }
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
    // A settings change (mic, echo cancellation) gets a fresh try if it failed before.
    const { cancelEcho, inputDeviceLabel } = this.deps.settings().voice;
    const key = `${cancelEcho}|${inputDeviceLabel}`;
    if (key !== this.aecSettings) {
      this.aecSettings = key;
      this.aecFailed = null;
    }
    this.controller.refresh();
  }

  private aecSettings = '';

  /**
   * Chooses where the mic comes from for this listening mode, and starts or stops Windows' echo
   * canceller to match.
   */
  private withMicSource(
    config: Extract<AudioCommand, { type: 'config' }>,
  ): Extract<AudioCommand, { type: 'config' }> {
    const { cancelEcho, inputDeviceLabel } = this.deps.settings().voice;
    const system = config.mode !== 'off' && cancelEcho && !this.aecFailed;
    if (system) this.aec.start(inputDeviceLabel);
    else this.aec.stop();
    return { ...config, source: system ? 'system' : 'browser' };
  }

  /** Whether the mic is echo-cancelled right now, or why not (Settings shows it). */
  get echoCancellation(): { active: boolean; problem: string | null } {
    return { active: this.aec.running, problem: this.aecFailed };
  }

  pushToTalk(): void {
    this.controller.pushToTalk();
  }

  /** A timer or reminder going off. */
  announce(text: string): void {
    this.controller.announce(text);
  }

  /** A notification, said only if Aida is free to talk right now (false: try later). */
  notify(text: string): boolean {
    return this.controller.notify(text);
  }

  /** Not listening, thinking or talking. */
  get free(): boolean {
    return this.controller.free;
  }

  /** The voice is installed and replies are read aloud. */
  get canTalk(): boolean {
    return this.deps.settings().voice.speakReplies && this.deps.models.isReady('kokoro');
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

  private speakerModel(): Promise<EmbeddingModel> {
    this.speakerModelLoad ??= loadSpeakerModel(
      this.deps.models.path('speaker/voxceleb_resnet34_LM.onnx'),
    );
    this.speakerModelLoad.catch(() => {
      this.speakerModelLoad = null;
    });
    return this.speakerModelLoad;
  }

  voiceIdStatus(): VoiceIdStatus {
    return {
      modelReady: this.deps.models.isReady('speaker'),
      enrolled: this.voiceprint !== null,
      recorded: this.enrollment.length,
      needed: this.adding ? ADD_SAMPLES : ENROLL_SAMPLES,
      saved: this.voiceprint?.samples.length ?? 0,
      outdated: this.voiceprint?.outdated ?? false,
    };
  }

  /**
   * Settings: record one sample of the owner saying "Hey Aida, …". add: this session adds to the
   * saved voiceprint (recorded with sound playing) instead of replacing it.
   */
  async recordVoiceSample(add = false): Promise<VoiceIdResult> {
    if (this.enrollment.length === 0) this.adding = add && this.voiceprint !== null;
    const fail = (error: string): VoiceIdResult => ({
      ok: false,
      error,
      status: this.voiceIdStatus(),
    });
    if (!this.deps.models.isReady('speaker')) return fail('Download voice recognition first.');
    if (!this.canListen()) return fail('Download the speech models first.');
    if (this.deps.settings().microphoneMuted) return fail('Unmute the microphone first.');
    this.enrollingUntil = Date.now() + ENROLL_QUIET_MS;
    const samples = await this.controller.recordSample();
    this.enrollingUntil = Date.now() + ENROLL_QUIET_MS;
    if (!samples) return fail("I didn't hear anything. Try again, a little louder.");
    if (samples.length < MIN_SPEECH_SAMPLES * 2)
      return fail('That was too short. Say the whole sentence.');
    try {
      this.enrollment.push(await embed(await this.speakerModel(), samples));
    } catch (err) {
      return fail(`Voice recognition failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, status: this.voiceIdStatus() };
  }

  /** Settings: save the recorded samples as the owner's voiceprint. */
  saveVoiceprint(): VoiceIdResult {
    const minimum = this.adding ? 1 : ENROLL_MINIMUM;
    if (this.enrollment.length < minimum)
      return {
        ok: false,
        error: `Record at least ${minimum} sample${minimum === 1 ? '' : 's'} first.`,
        status: this.voiceIdStatus(),
      };
    const print =
      this.adding && this.voiceprint
        ? addToVoiceprint(this.voiceprint, this.enrollment)
        : makeVoiceprint(this.enrollment);
    this.adding = false;
    this.enrollingUntil = 0;
    this.deps.voiceprints.save(print);
    this.voiceprint = print;
    this.enrollment = [];
    return { ok: true, status: this.voiceIdStatus(), consistency: enrollmentConsistency(print) };
  }

  cancelVoiceEnrollment(): VoiceIdStatus {
    this.enrollment = [];
    this.adding = false;
    this.enrollingUntil = 0;
    return this.voiceIdStatus();
  }

  clearVoiceprint(): VoiceIdStatus {
    this.deps.voiceprints.clear();
    this.voiceprint = null;
    this.enrollment = [];
    this.adding = false;
    this.enrollingUntil = 0;
    return this.voiceIdStatus();
  }

  dispose(): void {
    this.aec.stop();
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
