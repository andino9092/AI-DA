// Benchmarks Kokoro synthesis on this machine: node scripts/bench-tts.mjs <device> <dtype>
// device: cpu | dml (DirectML GPU) · dtype: q8 | fp32 | fp16 (the model file must be downloaded)
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { join } from 'node:path';

const [device = 'cpu', dtype = 'fp32'] = process.argv.slice(2);
env.allowRemoteModels = false;
env.localModelPath = join(process.env.APPDATA, 'AI-DA', 'models') + '/';

const t0 = performance.now();
const tts = await KokoroTTS.from_pretrained('kokoro', { dtype, device });
console.log(`${device}/${dtype}: loaded in ${Math.round(performance.now() - t0)} ms`);

for (const text of [
  "It's 4:00 PM.",
  "Hi, I'm Aida.",
  'Opening Spotify and setting the volume to thirty percent.',
]) {
  const t = performance.now();
  const audio = await tts.generate(text, { voice: 'af_heart' });
  const ms = performance.now() - t;
  const seconds = audio.audio.length / audio.sampling_rate;
  console.log(
    `  ${ms.toFixed(0).padStart(5)} ms for ${seconds.toFixed(2)} s of audio (RTF ${(ms / 1000 / seconds).toFixed(2)})  "${text}"`,
  );
}
