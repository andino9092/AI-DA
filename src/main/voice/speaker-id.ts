import { existsSync, readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomic-write';
import type { Cipher } from '../secrets/vault';
import { fbank, MEL_BINS } from './fbank';

/**
 * "Is this the owner's voice?" A small speaker-recognition model (WeSpeaker ResNet34, trained on
 * VoxCeleb) turns speech into a 256-number voice fingerprint; the same person's fingerprints
 * point the same way (high cosine similarity), other people's and devices' don't. Runs on the
 * CPU in ~40 ms; the audio never leaves the PC.
 */

/** Anything that turns fbank features into an embedding (the ONNX model, or a fake in tests). */
export interface EmbeddingModel {
  run(features: Float32Array, frames: number): Promise<Float32Array>;
}

/** Shorter speech gives unreliable fingerprints; such utterances aren't judged. */
export const MIN_SPEECH_SAMPLES = 16_000 * 0.6;

export async function loadSpeakerModel(path: string): Promise<EmbeddingModel> {
  // Loaded lazily: onnxruntime-node is a native module and only needed once voice ID is on.
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(path, {
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 2,
  });
  return {
    run: async (features, frames) => {
      const input = new ort.Tensor('float32', features, [1, frames, MEL_BINS]);
      const output = await session.run({ [session.inputNames[0]!]: input });
      return new Float32Array(output[session.outputNames[0]!]!.data as Float32Array);
    },
  };
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

/**
 * Only the loudest half of the speech is fingerprinted: the person talking to the mic is louder
 * than music or a video in the background, which otherwise drags their score down. Measured with
 * background as loud as the voice: the owner's lowest score rose from 0.22 to 0.43 (0.52 with
 * samples recorded over sound, see VoiceprintStore), while other voices stayed at or below 0.34.
 */
const KEEP_LOUDEST = 0.5;

/** How fingerprints are made; a voiceprint made differently should be recorded again. */
export const FINGERPRINT_METHOD = 'loudest-half';

/** The voice fingerprint of 16 kHz speech (unit length). */
export async function embed(model: EmbeddingModel, samples: Float32Array): Promise<Float32Array> {
  const { data, frames } = fbank(samples, { keepLoudest: KEEP_LOUDEST });
  return normalize(await model.run(data, frames));
}

/** The owner's enrolled voice: a fingerprint per recorded sample, and their average. */
export interface Voiceprint {
  samples: Float32Array[];
  centroid: Float32Array;
  /** Made by an older version: works, but recording again matches better. */
  outdated?: boolean;
}

/** Most samples a voiceprint keeps (quiet ones plus ones recorded over background sound). */
export const MAX_VOICEPRINT_SAMPLES = 15;

export function makeVoiceprint(samples: Float32Array[], outdated = false): Voiceprint {
  const centroid = new Float32Array(samples[0]!.length);
  for (const s of samples) s.forEach((x, i) => (centroid[i] = centroid[i]! + x));
  return { samples, centroid: normalize(centroid), ...(outdated ? { outdated } : {}) };
}

/**
 * Adds samples to a voiceprint, e.g. recorded while music plays, so the owner still matches with
 * sound in the background. When full, the oldest added samples make room (the first recording
 * session is kept).
 */
export function addToVoiceprint(print: Voiceprint, added: Float32Array[]): Voiceprint {
  const first = print.samples.slice(0, 5);
  const extra = [...print.samples.slice(5), ...added].slice(
    -(MAX_VOICEPRINT_SAMPLES - first.length),
  );
  return makeVoiceprint([...first, ...extra], print.outdated);
}

/** How much an utterance sounds like the owner: cosine similarity to their average voice. */
export function voiceMatch(print: Voiceprint, embedding: Float32Array): number {
  return cosine(print.centroid, embedding);
}

/**
 * How consistent the enrollment recordings are: the lowest similarity of any recording to the
 * average. Low values mean a noisy or mixed-up recording.
 */
export function enrollmentConsistency(print: Voiceprint): number {
  return Math.min(...print.samples.map((s) => cosine(print.centroid, s)));
}

const fileSchema = z.object({
  version: z.literal(1),
  /** Base64 of the encrypted JSON array of fingerprints. */
  data: z.string(),
  /** How the fingerprints were made (missing: the first version, all frames). */
  method: z.string().optional(),
});

/**
 * The owner's voiceprint on disk, encrypted with Windows (DPAPI) like API keys: a voice
 * fingerprint is biometric data. Never sent anywhere.
 */
export class VoiceprintStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  load(): Voiceprint | null {
    try {
      if (!existsSync(this.file) || !this.cipher.isEncryptionAvailable()) return null;
      const { data, method } = fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      const samples = z
        .array(z.array(z.number()).length(256))
        .min(1)
        .parse(JSON.parse(this.cipher.decryptString(Buffer.from(data, 'base64'))));
      return makeVoiceprint(
        samples.map((s) => Float32Array.from(s)),
        method !== FINGERPRINT_METHOD,
      );
    } catch {
      return null;
    }
  }

  save(print: Voiceprint): void {
    const json = JSON.stringify(print.samples.map((s) => Array.from(s)));
    const data = this.cipher.encryptString(json).toString('base64');
    const method = print.outdated ? undefined : FINGERPRINT_METHOD;
    writeFileAtomic(this.file, JSON.stringify({ version: 1, data, method }));
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
