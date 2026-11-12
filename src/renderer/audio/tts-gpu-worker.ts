/**
 * Kokoro on the graphics card (WebGPU), in a worker inside the hidden audio window so synthesis
 * never delays the microphone. About 2.5–3× faster than the CPU engine on an RTX 3070 Ti.
 *
 * Offline by construction: model files come from the local models folder and voices from the app
 * itself, both through the aida-model: protocol; any other request fails here (and the page's CSP
 * blocks the network anyway).
 */
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { createTtsHandler } from '@shared/tts-core';
import type { TtsRequest, TtsResponse } from '@shared/tts-protocol';
// The WebGPU build of ONNX Runtime that transformers.js uses, bundled locally (never a CDN).
import ortWasm from '../../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import ortMjs from '../../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url';

const MODELS = 'aida-model://models/';
const VOICES = 'aida-model://voices/';
/** Where kokoro-js looks for voices when it can't read files; answered locally below. */
const HUB_VOICES =
  'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/';

const scope = self as unknown as {
  postMessage(message: TtsResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<TtsRequest>) => void) | null;
  fetch: typeof fetch;
};

const localFetch = scope.fetch.bind(scope);
scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(HUB_VOICES)) return localFetch(VOICES + url.slice(HUB_VOICES.length), init);
  // The app's own files (file:, or the dev server) and aida-model: are fine; the web is not.
  const target = new URL(url, location.href);
  if (/^(?:https?|wss?):$/.test(target.protocol) && target.origin !== location.origin)
    return Promise.reject(new Error(`Blocked network request from the voice engine: ${url}`));
  return localFetch(input, init);
};

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = MODELS;
(env.backends.onnx as { wasm: { wasmPaths: unknown } }).wasm.wasmPaths = {
  wasm: ortWasm,
  mjs: ortMjs,
};

const handle = createTtsHandler(
  async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu || !(await gpu.requestAdapter()))
      throw new Error('No graphics card available (WebGPU).');
    const tts = await KokoroTTS.from_pretrained('kokoro', { dtype: 'fp32', device: 'webgpu' });
    return {
      generate: async (text, voice, speed) => {
        const audio = await tts.generate(text, { voice: voice as never, speed });
        return { samples: audio.audio, sampleRate: audio.sampling_rate };
      },
    };
  },
  (message) => scope.postMessage(message, message.type === 'chunk' ? [message.samples.buffer] : []),
);

scope.onmessage = (event) => handle(event.data);
