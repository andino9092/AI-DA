import type { TtsRequest, TtsResponse } from './tts-protocol';

/**
 * off: microphone closed · wake: always listening for "Hey Aida" · command: the next thing
 * said is a command (after the wake phrase alone, push-to-talk, or a follow-up question).
 */
export type ListenMode = 'off' | 'wake' | 'command';

export type Chime = 'listen' | 'done' | 'error' | 'alarm' | 'notify';

export type WakeSensitivity = 'low' | 'normal' | 'high';

/** Speech-detector thresholds per sensitivity: lower hears quieter speech, and more noise. */
export const VAD_THRESHOLDS: Record<WakeSensitivity, { positive: number; negative: number }> = {
  low: { positive: 0.6, negative: 0.45 },
  normal: { positive: 0.5, negative: 0.35 },
  high: { positive: 0.35, negative: 0.2 },
};

/**
 * How closely "Hey Aida" must match the owner's voiceprint (cosine similarity, 0–1). The owner
 * typically scores 0.6–0.9; other voices score well below.
 */
export const VOICE_MATCH_THRESHOLDS: Record<WakeSensitivity, number> = {
  low: 0.55,
  normal: 0.45,
  high: 0.38,
};

/** Main process → hidden audio window. */
export type AudioCommand =
  | {
      type: 'config';
      mode: ListenMode;
      deviceId: string | null;
      sensitivity: WakeSensitivity;
      /** Report the mic level continuously (Settings → Mic check is open). */
      meter: boolean;
      /** Push-to-talk is held: pauses don't end the command; releasing the key does. */
      hold: boolean;
      /**
       * browser: open the mic here (Chromium only removes our own playback). system: the mic
       * arrives as mic-audio from Windows' echo canceller, with all PC sound removed.
       */
      source: 'browser' | 'system';
    }
  /** Echo-cancelled microphone audio (source "system"): 16 kHz mono, whole 512-sample frames. */
  | { type: 'mic-audio'; samples: Float32Array }
  | { type: 'flush' }
  | { type: 'play'; id: string; samples: Float32Array; sampleRate: number }
  | { type: 'end-of-speech'; id: string }
  | { type: 'stop-playback' }
  | { type: 'chime'; chime: Chime }
  /** For the graphics-card voice engine running in the audio window. */
  | { type: 'tts'; request: TtsRequest };

/** Hidden audio window → main process. */
export type AudioEvent =
  | { type: 'ready' }
  | { type: 'mic-state'; open: boolean; error?: string }
  | { type: 'speech-start'; mode: ListenMode }
  | { type: 'command-timeout' }
  /** Push-to-talk was released without any speech in the recording. */
  | { type: 'no-speech' }
  | { type: 'level'; rms: number }
  | { type: 'playback-finished'; id: string }
  | { type: 'error'; message: string }
  /** From the graphics-card voice engine. */
  | { type: 'tts'; response: TtsResponse };

export interface Utterance {
  mode: ListenMode;
  /** 16 kHz mono float samples. */
  samples: Float32Array;
  /** Which stretch of speech this came from (counts up). */
  segment?: number;
  /** Sent during a pause so it can be transcribed early; the final one may reuse it. */
  tentative?: boolean;
  /** Same audio as this segment's tentative utterance: reuse its transcript. */
  reuse?: boolean;
  /** Cut out of continuous sound (music, TV); the speech carries on. */
  cut?: boolean;
}

/**
 * Settings → Mic check: what the wake-phrase check heard. Kept in memory for the open Settings
 * window only; never logged or saved.
 */
export interface HeardEvent {
  text: string;
  mode: ListenMode;
  /** Whether it counted as "Hey Aida" (or was a command after it). */
  accepted: boolean;
  /** Loudest moment, in dBFS. Below about -30 is quiet. */
  peakDb: number;
  /** How much it sounded like your recorded voice (0–1), when voice recognition is on. */
  voiceMatch?: number;
  /** Heard "Hey Aida", but not in your voice. */
  notYourVoice?: boolean;
  seconds: number;
}

/** Settings → "Only respond to my voice". */
export interface VoiceIdStatus {
  /** The voice-recognition model is downloaded. */
  modelReady: boolean;
  /** A voiceprint is saved. */
  enrolled: boolean;
  /** Samples recorded so far in the current recording session. */
  recorded: number;
  /** Samples a session records. */
  needed: number;
  /** Samples in the saved voiceprint. */
  saved: number;
  /** The saved voiceprint was made by an older version: recording again matches better. */
  outdated: boolean;
}

export type VoiceIdResult =
  | { ok: true; status: VoiceIdStatus; consistency?: number }
  | { ok: false; error: string; status: VoiceIdStatus };

/** Main process → Settings window while the mic check is open. */
export type MonitorEvent = { type: 'level'; rms: number } | { type: 'heard'; heard: HeardEvent };

export type OverlayPhase =
  | 'hidden'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'reply'
  | 'error'
  /** Aida asked "Send it? Say yes or no" and is waiting for the answer. */
  | 'confirm';

export interface OverlayState {
  phase: OverlayPhase;
  /** What you said (listening/thinking) or what Aida said (reply/speaking). */
  text?: string;
  /** Microphone level 0–1 while listening. */
  level?: number;
}

export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart (US, warm)' },
  { id: 'af_bella', label: 'Bella (US)' },
  { id: 'af_nicole', label: 'Nicole (US, soft)' },
  { id: 'am_michael', label: 'Michael (US)' },
  { id: 'am_fenrir', label: 'Fenrir (US, deep)' },
  { id: 'bf_emma', label: 'Emma (UK)' },
] as const;
