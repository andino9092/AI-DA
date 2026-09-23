/**
 * off: microphone closed · wake: always listening for "Hey Aida" · command: the next thing
 * said is a command (after the wake phrase alone, push-to-talk, or a follow-up question).
 */
export type ListenMode = 'off' | 'wake' | 'command';

export type Chime = 'listen' | 'done' | 'error';

/** Main process → hidden audio window. */
export type AudioCommand =
  | { type: 'config'; mode: ListenMode; deviceId: string | null }
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

export type OverlayPhase =
  'hidden' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'reply' | 'error';

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
