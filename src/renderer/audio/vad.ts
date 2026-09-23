import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

// Bundled locally: never fetch the runtime from a CDN. One thread avoids needing
// cross-origin isolation, and a 2 MB model runs in well under a millisecond per frame.
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;

const CONTEXT = 64;

/** Silero VAD v6: speech probability for each 512-sample (32 ms) frame at 16 kHz. */
export class SileroVad {
  private state: Float32Array = new Float32Array(2 * 128);
  private context = new Float32Array(CONTEXT);
  private readonly sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);

  private constructor(private readonly session: ort.InferenceSession) {}

  static async create(model: Uint8Array): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    return new SileroVad(session);
  }

  reset(): void {
    this.state = new Float32Array(2 * 128);
    this.context = new Float32Array(CONTEXT);
  }

  async probability(frame: Float32Array): Promise<number> {
    // Like the reference implementation: prepend the last 64 samples of the previous frame.
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);
    const [inputName, stateName, srName] = this.session.inputNames;
    const outputs = await this.session.run({
      [inputName!]: new ort.Tensor('float32', input, [1, input.length]),
      [stateName!]: new ort.Tensor('float32', this.state, [2, 1, 128]),
      [srName!]: this.sr,
    });
    const [probName, nextStateName] = this.session.outputNames;
    this.state = new Float32Array(outputs[nextStateName!]!.data as Float32Array);
    this.context = input.slice(-CONTEXT);
    return (outputs[probName!]!.data as Float32Array)[0]!;
  }
}
