import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fbank, frameCount, MEL_BINS } from '../../../src/main/voice/fbank';
import {
  addToVoiceprint,
  cosine,
  embed,
  MAX_VOICEPRINT_SAMPLES,
  enrollmentConsistency,
  loadSpeakerModel,
  makeVoiceprint,
  voiceMatch,
  VoiceprintStore,
} from '../../../src/main/voice/speaker-id';
import type { Cipher } from '../../../src/main/secrets/vault';
import { tempDir } from '../fakes';
import { VOICE_MATCH_THRESHOLDS } from '../../../src/shared/voice';

const SR = 16_000;
const tone = (hz: number, seconds = 1) =>
  Float32Array.from(
    { length: SR * seconds },
    (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / SR),
  );

describe('fbank', () => {
  it('makes one 80-band row per 10 ms, like Kaldi', () => {
    expect(frameCount(399)).toBe(0);
    expect(frameCount(400)).toBe(1);
    expect(frameCount(SR)).toBe(98);
    const { data, frames } = fbank(tone(440));
    expect(frames).toBe(98);
    expect(data.length).toBe(98 * MEL_BINS);
  });

  it('puts a tone’s energy in the right mel band', () => {
    // Without mean normalization this is easy to see, so compare two tones instead: the band
    // that is loudest for 300 Hz relative to 3 kHz must sit well below the one for 3 kHz.
    const low = fbank(new Float32Array([...tone(300), ...tone(3000)]));
    const band = (hz: number) => {
      const mel = (f: number) => 1127 * Math.log(1 + f / 700);
      const lo = mel(20);
      return Math.round(((mel(hz) - lo) / (mel(8000) - lo)) * (MEL_BINS + 1)) - 1;
    };
    // First half is 300 Hz, second half 3 kHz: after mean normalization, band(300) is positive
    // in the first half and negative in the second, and band(3000) the other way round.
    const at = (frame: number, b: number) => low.data[frame * MEL_BINS + b]!;
    expect(at(40, band(300))).toBeGreaterThan(0);
    expect(at(150, band(300))).toBeLessThan(0);
    expect(at(40, band(3000))).toBeLessThan(0);
    expect(at(150, band(3000))).toBeGreaterThan(0);
  });

  it('can keep only the loudest frames', () => {
    // 1 s of quiet noise, then 1 s of a loud tone: keeping half keeps (almost) only the tone.
    let seed = 3;
    const noise = Float32Array.from({ length: SR }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 0.002;
    });
    const loud = tone(1000);
    const both = new Float32Array([...noise, ...loud]);
    const half = fbank(both, { keepLoudest: 0.5 });
    expect(half.frames).toBe(Math.round(frameCount(both.length) * 0.5));
    // The kept frames match the tone's own features (after normalizing, a steady tone is ~0).
    const toneOnly = fbank(loud);
    const mean = (x: Float32Array) => x.reduce((a, b) => a + Math.abs(b), 0) / x.length;
    expect(mean(half.data)).toBeLessThan(mean(fbank(both).data) / 2);
    expect(Math.abs(mean(half.data) - mean(toneOnly.data))).toBeLessThan(0.5);
  });

  it('subtracts each band’s mean over time', () => {
    const { data, frames } = fbank(tone(1000));
    for (let m = 0; m < MEL_BINS; m += 17) {
      let sum = 0;
      for (let f = 0; f < frames; f++) sum += data[f * MEL_BINS + m]!;
      expect(Math.abs(sum / frames)).toBeLessThan(1e-3);
    }
  });
});

const unit = (values: number[]) => {
  const v = Float32Array.from({ length: 256 }, (_, i) => values[i % values.length]! + i * 1e-4);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

describe('voiceprint', () => {
  it('scores new speech against the average of the recordings', () => {
    const owner = [unit([1, 0.2, 0]), unit([0.9, 0.3, 0.1]), unit([1, 0.1, 0.05])];
    const print = makeVoiceprint(owner);
    expect(voiceMatch(print, unit([0.95, 0.2, 0.05]))).toBeGreaterThan(0.95);
    expect(voiceMatch(print, unit([0, 0.1, 1]))).toBeLessThan(0.5);
    expect(enrollmentConsistency(print)).toBeGreaterThan(0.95);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it('adds samples recorded over background sound, keeping the first session', () => {
    const quiet = Array.from({ length: 5 }, (_, i) => unit([1, 0.1 * i]));
    let print = makeVoiceprint(quiet);
    for (let round = 0; round < 5; round++)
      print = addToVoiceprint(print, [
        unit([0.5, 1, round]),
        unit([0.4, 1, round]),
        unit([0.6, 1, round]),
      ]);
    expect(print.samples).toHaveLength(MAX_VOICEPRINT_SAMPLES);
    expect(print.samples.slice(0, 5)).toEqual(quiet);
    // The newest added samples are the ones kept.
    expect(cosine(print.samples.at(-1)!, unit([0.6, 1, 4]))).toBeCloseTo(1, 5);
  });

  it('is stored encrypted, and deleted on request', () => {
    const cipher: Cipher = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
      decryptString: (b) => b.toString().split('').reverse().join(''),
    };
    const file = join(tempDir(), 'voiceprint.json');
    const store = new VoiceprintStore(file, cipher);
    expect(store.load()).toBeNull();
    const print = makeVoiceprint([unit([1, 0.2]), unit([0.8, 0.4])]);
    store.save(print);
    const loaded = store.load()!;
    expect(loaded.samples).toHaveLength(2);
    expect(cosine(loaded.centroid, print.centroid)).toBeCloseTo(1, 5);
    // Without the key (another PC, or encryption off) there is no voiceprint.
    expect(
      new VoiceprintStore(file, { ...cipher, isEncryptionAvailable: () => false }).load(),
    ).toBeNull();
    expect(loaded.outdated).toBeUndefined();
    // A voiceprint saved by the first version (no method) still loads, marked as outdated.
    writeFileSync(
      file,
      JSON.stringify({ version: 1, data: JSON.parse(readFileSync(file, 'utf8')).data }),
    );
    expect(store.load()!.outdated).toBe(true);
    store.clear();
    expect(existsSync(file)).toBe(false);
    expect(store.load()).toBeNull();
  });
});

/**
 * The real model on real-sounding speech: Kokoro's voices stand in for people. Needs the
 * downloaded models, so it only runs on a PC with AI-DA's models installed.
 */
const models = join(process.env['APPDATA'] ?? '', 'AI-DA', 'models');
const installed =
  existsSync(join(models, 'speaker', 'voxceleb_resnet34_LM.onnx')) &&
  existsSync(join(models, 'kokoro', 'onnx', 'model.onnx'));

describe.skipIf(!installed)('voice recognition with the real model', () => {
  /** 24 kHz → 16 kHz, with a light low-pass first. */
  function to16k(x: Float32Array): Float32Array {
    const smooth = x.map((v, i) => ((x[i - 1] ?? v) + 2 * v + (x[i + 1] ?? v)) / 4);
    return Float32Array.from({ length: Math.floor((x.length * 2) / 3) }, (_, i) => {
      const t = (i * 3) / 2;
      const a = Math.floor(t);
      return smooth[a]! + ((smooth[a + 1] ?? smooth[a]!) - smooth[a]!) * (t - a);
    });
  }

  it('tells the enrolled voice from other voices', async () => {
    const { env } = await import('@huggingface/transformers');
    const { KokoroTTS } = await import('kokoro-js');
    env.allowRemoteModels = false;
    env.localModelPath = `${models}/`;
    const tts = await KokoroTTS.from_pretrained('kokoro', { dtype: 'fp32', device: 'cpu' });
    const model = await loadSpeakerModel(join(models, 'speaker', 'voxceleb_resnet34_LM.onnx'));
    const say = async (voice: string, text: string) =>
      embed(model, to16k((await tts.generate(text, { voice: voice as never })).audio));

    const enrollment = [
      'Hey Aida, what is the weather today?',
      'Hey Aida, pause the music.',
      'Hey Aida, set a timer for ten minutes.',
      'Hey Aida, open Spotify.',
    ];
    const test = 'Hey Aida, skip this song and turn it up a bit.';
    for (const [owner, other] of [
      ['am_michael', 'bf_emma'],
      ['bf_emma', 'am_michael'],
    ] as const) {
      const print = makeVoiceprint(await Promise.all(enrollment.map((t) => say(owner, t))));
      expect(enrollmentConsistency(print)).toBeGreaterThan(0.6);
      // The owner saying something new clears Low's threshold; other voices stay under Normal's.
      expect(voiceMatch(print, await say(owner, test))).toBeGreaterThan(VOICE_MATCH_THRESHOLDS.low);
      expect(voiceMatch(print, await say(other, test))).toBeLessThan(VOICE_MATCH_THRESHOLDS.normal);
      expect(voiceMatch(print, await say('af_heart', test))).toBeLessThan(
        VOICE_MATCH_THRESHOLDS.normal,
      );
    }
  }, 180_000);

  it('still recognizes the owner with music and a video playing', async () => {
    const { env } = await import('@huggingface/transformers');
    const { KokoroTTS } = await import('kokoro-js');
    env.allowRemoteModels = false;
    env.localModelPath = `${models}/`;
    const tts = await KokoroTTS.from_pretrained('kokoro', { dtype: 'fp32', device: 'cpu' });
    const model = await loadSpeakerModel(join(models, 'speaker', 'voxceleb_resnet34_LM.onnx'));
    const speech = async (voice: string, text: string) =>
      to16k((await tts.generate(text, { voice: voice as never })).audio);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    // Background: chords plus someone talking in a video.
    const video = await speech(
      'am_adam',
      'Welcome back to the channel, today we are reviewing the new phone, and it is fast.',
    );
    let offset = 0;
    const background = (n: number) => {
      offset += 7919;
      return Float32Array.from({ length: n }, (_, j) => {
        const i = j + offset;
        const notes = [220, 277, 330, 196, 262, 294][Math.floor(i / 8000) % 6]!;
        return 0.1 * Math.sin((2 * Math.PI * notes * i) / SR) + 0.6 * video[i % video.length]!;
      });
    };
    /** Speech with 0.3 s of background around it, at a speech-to-background ratio (dB). */
    const withBackground = (x: Float32Array, snrDb: number) => {
      const pad = 0.3 * SR;
      const bg = background(x.length + 2 * pad);
      const gain = rms(x) / (rms(bg) * 10 ** (snrDb / 20));
      const out = bg.map((v) => v * gain);
      x.forEach((v, i) => (out[pad + i] = out[pad + i]! + v));
      return out;
    };

    const enrollment = [
      'Hey Aida, what is the weather today?',
      'Hey Aida, pause the music.',
      'Hey Aida, set a timer for ten minutes.',
      'Hey Aida, open Spotify.',
      'Hey Aida, what time is it?',
    ];
    const tests = ['Hey Aida, skip this song.', 'Hey Aida, close Discord.'];
    for (const [owner, other] of [
      ['am_michael', 'bf_emma'],
      ['bf_emma', 'am_fenrir'],
    ] as const) {
      const quiet = await Promise.all(enrollment.map((t) => speech(owner, t)));
      let print = makeVoiceprint(await Promise.all(quiet.map((a) => embed(model, a))));
      // "Add samples with sound playing".
      print = addToVoiceprint(
        print,
        await Promise.all(quiet.slice(0, 3).map((a) => embed(model, withBackground(a, 6)))),
      );
      for (const text of tests) {
        const ownerSpeech = await speech(owner, text);
        const otherSpeech = await speech(other, text);
        const score = async (x: Float32Array, snr: number) =>
          voiceMatch(print, await embed(model, withBackground(x, snr)));
        // Background 6 dB under the voice (what's left after echo cancellation, or a speaker
        // across the room): the owner clears Normal, the other voice stays under High.
        expect(await score(ownerSpeech, 6)).toBeGreaterThan(VOICE_MATCH_THRESHOLDS.normal);
        expect(await score(otherSpeech, 6)).toBeLessThan(VOICE_MATCH_THRESHOLDS.high);
        // Another person talking as loud as the owner: still clearly apart, but the owner can
        // fall under the thresholds (use push-to-talk then, or turn the other sound down).
        const mine = await score(ownerSpeech, 0);
        const theirs = await score(otherSpeech, 0);
        expect(mine - theirs).toBeGreaterThan(0.1);
      }
    }
  }, 300_000);
});
