export interface ModelStatus {
  id: 'vad' | 'whisper-runtime' | 'whisper-model' | 'kokoro' | 'speaker';
  label: string;
  purpose: string;
  /** Download size. */
  bytes: number;
  state: 'missing' | 'downloading' | 'ready' | 'error';
  /** Bytes downloaded so far while downloading. */
  received: number;
  error?: string;
}
