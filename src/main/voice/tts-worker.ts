/**
 * Text-to-speech worker, run in an Electron utility process so synthesis never blocks the UI.
 * Kokoro runs on the CPU through onnxruntime-node, loading only local files: remote model
 * downloads are disabled, so nothing about what AI-DA says leaves the PC.
 */
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { splitForSpeech } from './sentences';
import type { TtsRequest, TtsResponse } from './tts-protocol';

const port = process.parentPort;
const send = (message: TtsResponse) => port.postMessage(message);

let tts: KokoroTTS | null = null;
let queue: Promise<void> = Promise.resolve();
const cancelled = new Set<string>();

async function init(modelsDir: string): Promise<void> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath =
    modelsDir.endsWith('/') || modelsDir.endsWith('\\') ? modelsDir : `${modelsDir}/`;
  tts = await KokoroTTS.from_pretrained('kokoro', { dtype: 'fp32', device: 'cpu' });
  send({ type: 'ready' });
}

async function speak(id: string, text: string, voice: string, speed: number): Promise<void> {
  if (!tts) throw new Error('Voice model is not loaded.');
  let index = 0;
  for (const chunk of splitForSpeech(text)) {
    if (cancelled.has(id)) break;
    const audio = await tts.generate(chunk, { voice: voice as never, speed });
    if (cancelled.has(id)) break;
    send({
      type: 'chunk',
      id,
      samples: audio.audio,
      sampleRate: audio.sampling_rate,
      index: index++,
    });
  }
  cancelled.delete(id);
  send({ type: 'done', id });
}

port.on('message', (event: { data: TtsRequest }) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled.add(message.id);
    return;
  }
  queue = queue
    .then(() =>
      message.type === 'init'
        ? init(message.modelsDir)
        : speak(message.id, message.text, message.voice, message.speed),
    )
    .catch((err: unknown) => {
      send({
        type: 'error',
        id: message.type === 'speak' ? message.id : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    });
});
