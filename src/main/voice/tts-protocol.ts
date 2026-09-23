/** Messages between the main process and the text-to-speech utility process. */
export type TtsRequest =
  | { type: 'init'; modelsDir: string }
  | { type: 'speak'; id: string; text: string; voice: string; speed: number }
  | { type: 'cancel'; id: string };

export type TtsResponse =
  | { type: 'ready' }
  | { type: 'chunk'; id: string; samples: Float32Array; sampleRate: number; index: number }
  | { type: 'done'; id: string }
  | { type: 'error'; id?: string; message: string };
