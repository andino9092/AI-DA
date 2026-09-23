/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

/** Loudest sample in dBFS (0 = full scale, -Infinity = silence). */
export function peakDbfs(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return 20 * Math.log10(peak);
}

/**
 * Raises quiet recordings (old or distant mics) so the loudest sample sits near full scale.
 * Gain is capped so background hiss isn't blown up, and loud audio is left alone.
 */
export function normalizePeak(samples: Float32Array, target = 0.9, maxGain = 10): Float32Array {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak === 0 || peak >= target) return samples;
  const gain = Math.min(maxGain, target / peak);
  return samples.map((s) => s * gain);
}
