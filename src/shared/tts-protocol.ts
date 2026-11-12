/** Messages between the main process and a voice engine (CPU utility process or GPU worker). */
export type TtsRequest =
  | { type: 'init'; modelsDir: string }
  | { type: 'speak'; id: string; text: string; voice: string; speed: number }
  | { type: 'cancel'; id: string };

export type TtsResponse =
  | { type: 'ready' }
  | { type: 'chunk'; id: string; samples: Float32Array; sampleRate: number; index: number }
  | { type: 'done'; id: string }
  | { type: 'error'; id?: string; message: string };
