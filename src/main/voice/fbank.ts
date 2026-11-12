/**
 * Kaldi-style log mel filterbank features, the input the speaker-recognition model was trained
 * on (WeSpeaker uses torchaudio.compliance.kaldi.fbank with these settings): 16 kHz audio,
 * 25 ms Hamming windows every 10 ms, DC removal, pre-emphasis 0.97, a 512-point power spectrum,
 * 80 mel bands from 20 Hz to 8 kHz, natural log. Then each band's mean over time is subtracted.
 */

const SAMPLE_RATE = 16_000;
const FRAME = 400; // 25 ms
const SHIFT = 160; // 10 ms
const FFT = 512;
export const MEL_BINS = 80;
const LOW_HZ = 20;
const PREEMPHASIS = 0.97;
const EPS = 1.1920929e-7; // float32 epsilon, Kaldi's floor before the log

const mel = (hz: number) => 1127 * Math.log(1 + hz / 700);

/** Triangular mel filters over the FFT bins (80 × 257), as in Kaldi's get_mel_banks. */
function melBanks(): Float32Array[] {
  const bins = FFT / 2;
  const binHz = SAMPLE_RATE / FFT;
  const lowMel = mel(LOW_HZ);
  const highMel = mel(SAMPLE_RATE / 2);
  const delta = (highMel - lowMel) / (MEL_BINS + 1);
  const banks: Float32Array[] = [];
  for (let m = 0; m < MEL_BINS; m++) {
    const left = lowMel + m * delta;
    const center = left + delta;
    const right = center + delta;
    const bank = new Float32Array(bins + 1); // the Nyquist bin stays 0
    for (let b = 0; b < bins; b++) {
      const f = mel(binHz * b);
      const up = (f - left) / (center - left);
      const down = (right - f) / (right - center);
      bank[b] = Math.max(0, Math.min(up, down));
    }
    banks.push(bank);
  }
  return banks;
}

const BANKS = melBanks();
const WINDOW = Float32Array.from(
  { length: FRAME },
  (_, n) => 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FRAME - 1)),
);

/** In-place radix-2 FFT of a real signal (imag starts at 0). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(step * k);
        const sin = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * cos - im[b]! * sin;
        const ti = re[b]! * sin + im[b]! * cos;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/** Number of 10 ms frames Kaldi makes from this many samples (whole frames only). */
export function frameCount(samples: number): number {
  return samples < FRAME ? 0 : 1 + Math.floor((samples - FRAME) / SHIFT);
}

/**
 * Features for 16 kHz mono audio in [-1, 1]: frames × 80, row-major, mean-normalized per band.
 *
 * keepLoudest (0–1): use only that share of the frames, the loudest ones. The speaker nearest the
 * mic is the loudest thing in the recording; the quiet frames between words are mostly background
 * (music, a video, a TV), which would pull the voice fingerprint away from theirs.
 */
export function fbank(
  samples: Float32Array,
  options: { keepLoudest?: number } = {},
): { data: Float32Array; frames: number } {
  const all = frameCount(samples.length);
  const data = new Float32Array(all * MEL_BINS);
  const loudness = new Float64Array(all);
  const frames = all;
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  for (let f = 0; f < frames; f++) {
    const start = f * SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += samples[start + i]!;
    mean /= FRAME;
    // Kaldi scales audio to 16-bit range; remove DC, pre-emphasize, window, zero-pad.
    let previous = (samples[start]! - mean) * 32768;
    for (let i = 0; i < FRAME; i++) {
      const x = (samples[start + i]! - mean) * 32768;
      re[i] = (x - PREEMPHASIS * previous) * WINDOW[i]!;
      previous = x;
    }
    re.fill(0, FRAME);
    im.fill(0);
    fft(re, im);
    for (let b = 0; b <= FFT / 2; b++)
      loudness[f] = loudness[f]! + re[b]! * re[b]! + im[b]! * im[b]!;
    for (let m = 0; m < MEL_BINS; m++) {
      const bank = BANKS[m]!;
      let energy = 0;
      for (let b = 0; b <= FFT / 2; b++) {
        const w = bank[b]!;
        if (w) energy += w * (re[b]! * re[b]! + im[b]! * im[b]!);
      }
      data[f * MEL_BINS + m] = Math.log(Math.max(energy, EPS));
    }
  }
  return normalizeMeans(selectLoudest(data, loudness, options.keepLoudest ?? 1));
}

/** The loudest share of the frames, in their original order. */
function selectLoudest(
  data: Float32Array,
  loudness: Float64Array,
  keep: number,
): { data: Float32Array; frames: number } {
  const frames = loudness.length;
  const count = Math.max(1, Math.round(frames * Math.min(1, keep)));
  if (count >= frames) return { data, frames };
  const threshold = [...loudness].sort((a, b) => b - a)[count - 1]!;
  const kept = new Float32Array(count * MEL_BINS);
  let row = 0;
  for (let f = 0; f < frames && row < count; f++) {
    if (loudness[f]! < threshold) continue;
    kept.set(data.subarray(f * MEL_BINS, (f + 1) * MEL_BINS), row * MEL_BINS);
    row++;
  }
  return { data: kept, frames: count };
}

/** Mean normalization over time, per band. */
function normalizeMeans(features: { data: Float32Array; frames: number }): {
  data: Float32Array;
  frames: number;
} {
  const { data, frames } = features;
  for (let m = 0; m < MEL_BINS; m++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += data[f * MEL_BINS + m]!;
    const mean = frames ? sum / frames : 0;
    for (let f = 0; f < frames; f++) data[f * MEL_BINS + m] = data[f * MEL_BINS + m]! - mean;
  }
  return features;
}
