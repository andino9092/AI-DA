import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTtsHandler, type SpeechModel } from '../../../src/shared/tts-core';
import type { TtsRequest, TtsResponse } from '../../../src/shared/tts-protocol';
import { TtsService, type TtsEngine, type TtsTransport } from '../../../src/main/voice/tts';

vi.mock('electron', () => ({ net: {}, protocol: {} }));
const { resolveModelUrl } = await import('../../../src/main/app/model-protocol');

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A model that "speaks" one sample per character. */
const fakeModel = (log: string[] = []): SpeechModel => ({
  generate: async (text) => {
    log.push(text);
    return { samples: new Float32Array(text.length), sampleRate: 24_000 };
  },
});

describe('createTtsHandler', () => {
  it('loads once, then speaks sentence by sentence', async () => {
    const sent: TtsResponse[] = [];
    const handle = createTtsHandler(
      async () => fakeModel(),
      (m) => sent.push(m),
    );
    handle({ type: 'init', modelsDir: 'x' });
    handle({ type: 'speak', id: 'a', text: 'Opening Spotify. Volume set.', voice: 'v', speed: 1 });
    await tick();
    await tick();
    expect(sent.map((m) => m.type)).toEqual(['ready', 'chunk', 'chunk', 'done']);
    expect(sent.filter((m) => m.type === 'chunk').map((m) => m.index)).toEqual([0, 1]);
  });

  it('stops between sentences when cancelled', async () => {
    const sent: TtsResponse[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = createTtsHandler(
      async () => ({
        generate: async (text) => {
          await gate;
          return { samples: new Float32Array(text.length), sampleRate: 24_000 };
        },
      }),
      (m) => sent.push(m),
    );
    handle({ type: 'init', modelsDir: 'x' });
    handle({ type: 'speak', id: 'a', text: 'One. Two. Three.', voice: 'v', speed: 1 });
    await tick();
    handle({ type: 'cancel', id: 'a' });
    release();
    await tick();
    await tick();
    expect(sent.map((m) => m.type)).toEqual(['ready', 'done']);
  });

  it('reports a failed load without an id, and a failed reply with one', async () => {
    const sent: TtsResponse[] = [];
    const broken = createTtsHandler(
      async () => {
        throw new Error('No graphics card available (WebGPU).');
      },
      (m) => sent.push(m),
    );
    broken({ type: 'init', modelsDir: 'x' });
    broken({ type: 'speak', id: 'a', text: 'Hi.', voice: 'v', speed: 1 });
    await tick();
    await tick();
    expect(sent).toEqual([
      { type: 'error', id: undefined, message: 'No graphics card available (WebGPU).' },
      { type: 'error', id: 'a', message: 'Voice model is not loaded.' },
    ]);
  });
});

/** An engine backed by the real handler and a fake model, or one that fails to load. */
function engine(
  name: string,
  options: { fails?: boolean; silent?: boolean; spoken?: string[] } = {},
): TtsEngine & { transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];
  return {
    name,
    initTimeoutMs: 50,
    transports,
    create: () => {
      const t = new FakeTransport(options);
      transports.push(t);
      return t;
    },
  };
}

class FakeTransport implements TtsTransport {
  stopped = false;
  private onMessage: (m: TtsResponse) => void = () => {};
  private onExit: () => void = () => {};
  private readonly handle: (m: TtsRequest) => void;

  constructor(private readonly options: { fails?: boolean; silent?: boolean; spoken?: string[] }) {
    this.handle = createTtsHandler(
      async () => {
        if (options.fails) throw new Error('No graphics card available (WebGPU).');
        return fakeModel(options.spoken);
      },
      (m) => this.onMessage(m),
    );
  }

  post(message: TtsRequest): void {
    if (!this.options.silent) this.handle(message);
  }
  listen(onMessage: (m: TtsResponse) => void, onExit: () => void): void {
    this.onMessage = onMessage;
    this.onExit = onExit;
  }
  stop(): void {
    this.stopped = true;
  }
  exit(): void {
    this.onExit();
  }
}

const speak = (tts: TtsService, text: string) => {
  const chunks: Float32Array[] = [];
  return tts.speak(text, { voice: 'v', speed: 1 }, (s) => chunks.push(s)).then(() => chunks);
};

describe('TtsService', () => {
  it('uses the graphics card when it starts', async () => {
    const gpu = engine('gpu');
    const cpu = engine('cpu');
    const tts = new TtsService([gpu, cpu], () => 'models');
    expect(await speak(tts, 'Opening Spotify.')).toHaveLength(1);
    expect(tts.engine).toBe('gpu');
    expect(cpu.transports).toHaveLength(0);
  });

  it('falls back to the CPU when the graphics card fails or hangs, and stays there', async () => {
    for (const broken of [engine('gpu', { fails: true }), engine('gpu', { silent: true })]) {
      const cpu = engine('cpu');
      const log: string[] = [];
      const tts = new TtsService(
        [broken, cpu],
        () => 'models',
        (m) => log.push(m),
      );
      await speak(tts, 'Paused.');
      expect(tts.engine).toBe('cpu');
      expect(broken.transports[0]!.stopped).toBe(true);
      expect(log.some((m) => m.startsWith('voice engine gpu unavailable'))).toBe(true);
      // Restarting later (e.g. after the CPU engine exits) doesn't retry the broken engine.
      cpu.transports[0]!.exit();
      await speak(tts, 'Done again.');
      expect(broken.transports).toHaveLength(1);
      expect(cpu.transports).toHaveLength(2);
    }
  });

  it('fails the reply and restarts the engine when it dies mid-way', async () => {
    const gpu = engine('gpu', { silent: false });
    const tts = new TtsService([gpu], () => 'models');
    await speak(tts, 'Warm up.');
    // The audio window reloads while nothing is playing: the next reply starts it again.
    gpu.transports[0]!.exit();
    await speak(tts, 'Hello again.');
    expect(gpu.transports).toHaveLength(2);
    expect(tts.engine).toBe('gpu');
  });

  it('plays short replies from its cache the second time', async () => {
    const spoken: string[] = [];
    const tts = new TtsService([engine('gpu', { spoken })], () => 'models');
    await speak(tts, 'Paused.');
    await speak(tts, 'Paused.');
    expect(spoken).toEqual(['Paused.']);
  });
});

describe('aida-model protocol', () => {
  const roots = { modelsDir: join('C:', 'models'), voicesDir: join('C:', 'app', 'voices') };

  it('serves the Kokoro model and bundled voices', () => {
    expect(resolveModelUrl('aida-model://models/kokoro/onnx/model.onnx', roots)).toBe(
      join(roots.modelsDir, 'kokoro', 'onnx', 'model.onnx'),
    );
    expect(resolveModelUrl('aida-model://voices/af_heart.bin', roots)).toBe(
      join(roots.voicesDir, 'af_heart.bin'),
    );
  });

  it.each([
    'aida-model://models/whisper/ggml.bin',
    'aida-model://models/kokoro/../../secret.txt',
    'aida-model://models/kokoro/%2e%2e/%2e%2e/vault.json',
    'aida-model://voices/../vault.json',
    'aida-model://voices/af_heart.onnx',
    'aida-model://other/kokoro/config.json',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolveModelUrl(url, roots)).toBeNull();
  });
});
