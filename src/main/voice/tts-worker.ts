/**
 * Text-to-speech on the CPU, run in an Electron utility process so synthesis never blocks the UI.
 * This is the fallback when the graphics-card voice (in the audio window) can't start. Kokoro runs
 * through onnxruntime-node, loading only local files: remote model downloads are disabled, so
 * nothing about what AI-DA says leaves the PC.
 */
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { createTtsHandler } from '@shared/tts-core';
import type { TtsRequest, TtsResponse } from '@shared/tts-protocol';

const port = process.parentPort;

const handle = createTtsHandler(
  async (modelsDir) => {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath =
      modelsDir.endsWith('/') || modelsDir.endsWith('\\') ? modelsDir : `${modelsDir}/`;
    const tts = await KokoroTTS.from_pretrained('kokoro', { dtype: 'fp32', device: 'cpu' });
    return {
      generate: async (text, voice, speed) => {
        const audio = await tts.generate(text, { voice: voice as never, speed });
        return { samples: audio.audio, sampleRate: audio.sampling_rate };
      },
    };
  },
  (message: TtsResponse) => port.postMessage(message),
);

port.on('message', (event: { data: TtsRequest }) => handle(event.data));
