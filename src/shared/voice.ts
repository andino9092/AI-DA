/**
 * off: microphone closed · wake: always listening for "Hey Aida" · command: the next thing
 * said is a command (after the wake phrase alone, push-to-talk, or a follow-up question).
 */
export type ListenMode = 'off' | 'wake' | 'command';

export type Chime = 'listen' | 'done' | 'error';

export type WakeSensitivity = 'low' | 'normal' | 'high';

/** Speech-detector thresholds per sensitivity: lower hears quieter speech, and more noise. */
export const VAD_THRESHOLDS: Record<WakeSensitivity, { positive: number; negative: number }> = {
  low: { positive: 0.6, negative: 0.45 },
  normal: { positive: 0.5, negative: 0.35 },
  high: { positive: 0.35, negative: 0.2 },
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
    }
  | { type: 'flush' }
  | { type: 'play'; id: string; samples: Float32Array; sampleRate: number }
  | { type: 'end-of-speech'; id: string }
  | { type: 'stop-playback' }
  | { type: 'chime'; chime: Chime };

/** Hidden audio window → main process. */
export type AudioEvent =
  | { type: 'ready' }
  | { type: 'mic-state'; open: boolean; error?: string }
  | { type: 'speech-start'; mode: ListenMode }
  | { type: 'command-timeout' }
  | { type: 'level'; rms: number }
  | { type: 'playback-finished'; id: string }
  | { type: 'error'; message: string };

export interface Utterance {
  mode: ListenMode;
  /** 16 kHz mono float samples. */
  samples: Float32Array;
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
  seconds: number;
}

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
