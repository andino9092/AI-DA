import { splitForSpeech } from './sentences';
import type { TtsRequest, TtsResponse } from './tts-protocol';

/** A loaded voice model: text in, audio out. */
export interface SpeechModel {
  generate(
    text: string,
    voice: string,
    speed: number,
  ): Promise<{ samples: Float32Array; sampleRate: number }>;
}

/**
 * The synthesis loop both voice engines share (Kokoro on the CPU in a utility process, or on the
 * graphics card in the audio window): one reply at a time, sentence by sentence so the first one
 * can play while the rest is made, and cancellable between sentences.
 */
export function createTtsHandler(
  load: (modelsDir: string) => Promise<SpeechModel>,
  send: (message: TtsResponse) => void,
): (message: TtsRequest) => void {
  let model: SpeechModel | null = null;
  let queue: Promise<void> = Promise.resolve();
  const cancelled = new Set<string>();

  async function speak(id: string, text: string, voice: string, speed: number): Promise<void> {
    if (!model) throw new Error('Voice model is not loaded.');
    let index = 0;
    for (const chunk of splitForSpeech(text)) {
      if (cancelled.has(id)) break;
      const { samples, sampleRate } = await model.generate(chunk, voice, speed);
      if (cancelled.has(id)) break;
      send({ type: 'chunk', id, samples, sampleRate, index: index++ });
    }
    cancelled.delete(id);
    send({ type: 'done', id });
  }

  return (message) => {
    if (message.type === 'cancel') {
      cancelled.add(message.id);
      return;
    }
    queue = queue
      .then(async () => {
        if (message.type === 'init') {
          model = await load(message.modelsDir);
          send({ type: 'ready' });
        } else await speak(message.id, message.text, message.voice, message.speed);
      })
      .catch((err: unknown) => {
        send({
          type: 'error',
          id: message.type === 'speak' ? message.id : undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };
}
