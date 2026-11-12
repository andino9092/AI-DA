import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AecCapture,
  FRAME_SAMPLES,
  PcmFramer,
  type Spawn,
} from '../../../src/main/voice/aec-capture';
import { tempDir } from '../fakes';

const SR = 16_000;

function pcm(samples: Float32Array): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) =>
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2),
  );
  return b;
}

describe('PcmFramer', () => {
  it('turns PCM arriving in odd chunk sizes into whole frames, two at a time', () => {
    const batches: Float32Array[] = [];
    const framer = new PcmFramer((b) => batches.push(b));
    const audio = new Float32Array(FRAME_SAMPLES * 5).map((_, i) => ((i % 100) - 50) / 100);
    const bytes = pcm(audio);
    for (let i = 0; i < bytes.length; i += 333) framer.push(bytes.subarray(i, i + 333));
    // 5 frames: two batches of two; the fifth waits for its partner.
    expect(batches.map((b) => b.length)).toEqual([FRAME_SAMPLES * 2, FRAME_SAMPLES * 2]);
    expect(batches[0]![100]).toBeCloseTo(audio[100]!, 3);
    expect(batches[1]![FRAME_SAMPLES * 2 - 1]).toBeCloseTo(audio[FRAME_SAMPLES * 4 - 1]!, 3);
  });
});

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function capture(now = () => 0, startTimeoutMs = 4000) {
  const spawned: { args: string[]; proc: FakeProcess }[] = [];
  const events = { audio: 0, failed: [] as string[], started: 0 };
  const spawn: Spawn = (_exe, args) => {
    const proc = new FakeProcess();
    spawned.push({ args, proc });
    return proc as unknown as ReturnType<Spawn>;
  };
  const aec = new AecCapture(
    'aida-win.exe',
    {
      onAudio: () => events.audio++,
      onFailed: (r) => events.failed.push(r),
      onStarted: () => events.started++,
    },
    spawn,
    now,
    startTimeoutMs,
  );
  return { aec, spawned, events };
}

describe('AecCapture', () => {
  it('passes the chosen microphone and forwards audio', () => {
    const { aec, spawned, events } = capture();
    aec.start('Microphone (USB Audio)');
    aec.start('Microphone (USB Audio)'); // already running: no second process
    expect(spawned.map((s) => s.args)).toEqual([
      ['aec-capture', '--mic', 'Microphone (USB Audio)'],
    ]);
    const proc = spawned[0]!.proc;
    proc.stderr.write('{"event":"started","mic":0,"speaker":1}\n');
    proc.stdout.write(Buffer.alloc(FRAME_SAMPLES * 2 * 2));
    expect(events).toMatchObject({ started: 1, audio: 1, failed: [] });
  });

  it('restarts for a different microphone and closes the old one', () => {
    const { aec, spawned } = capture();
    aec.start(null);
    aec.start('Headset');
    expect(spawned.map((s) => s.args)).toEqual([
      ['aec-capture'],
      ['aec-capture', '--mic', 'Headset'],
    ]);
    expect(spawned[0]!.proc.stdin.writableEnded).toBe(true);
  });

  it('reports when Windows echo cancellation cannot run, so the normal mic is used', () => {
    const { aec, spawned, events } = capture();
    aec.start(null);
    spawned[0]!.proc.stderr.write('{"event":"error","message":"Class not registered"}\n');
    expect(events.failed).toEqual(['Class not registered']);
    expect(aec.running).toBe(false);
    // An exit after it was stopped on purpose isn't a failure.
    const again = capture();
    again.aec.start(null);
    again.aec.stop();
    again.spawned[0]!.proc.emit('exit', 0);
    expect(again.events.failed).toEqual([]);
  });

  it('ignores output until the helper says it started, and gives up if it never does', async () => {
    // An older helper without echo cancellation prints its normal greeting and waits forever.
    const { aec, spawned, events } = capture(() => 0, 20);
    aec.start(null);
    spawned[0]!.proc.stdout.write(Buffer.from('{"ready":true}\n'.repeat(200)));
    expect(events.audio).toBe(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(events.failed).toEqual(['no answer from the echo canceller']);
    expect(spawned[0]!.proc.killed).toBe(true);
  });

  it('treats an unexpected exit as a failure', () => {
    const { aec, spawned, events } = capture();
    aec.start(null);
    spawned[0]!.proc.emit('exit', 3);
    expect(events.failed).toEqual(['stopped right away (code 3)']);
  });
});

/**
 * Windows' Voice Capture DSP on files, with no audio devices involved: "music" played through a
 * simulated room echo, and a voice-like sound in the middle. Compiles the helper first.
 */
describe.skipIf(process.platform !== 'win32')("Windows' echo canceller (aida-win.exe)", () => {
  const dir = tempDir();
  const exe = join(dir, 'aida-win.exe');
  let unavailable: string | null = null;

  beforeAll(() => {
    execFileSync(process.execPath, [resolve('scripts/build-native.mjs'), '--force', '--out', exe]);
  }, 120_000);

  it('removes the echo of what the speakers play, and keeps the voice', () => {
    const seconds = 8;
    const n = SR * seconds;
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const notes = [220, 277, 330, 247, 311, 370, 196, 262, 294];
    const music = new Float32Array(n).map((_, i) => {
      const bar = Math.floor(i / (SR / 2)) % 3;
      let v = 0;
      for (let k = 0; k < 3; k++) v += Math.sin((2 * Math.PI * notes[bar * 3 + k]! * i) / SR);
      return 0.12 * v + 0.02 * rand();
    });
    // What reaches the mic from the speakers: delayed and smeared by the room.
    const echo = music.map(
      (_, i) =>
        0.5 * (music[i - 480] ?? 0) + 0.25 * (music[i - 900] ?? 0) + 0.1 * (music[i - 1500] ?? 0),
    );
    // A voice-like sound (150 Hz harmonics, four syllables a second) from 5 to 7 s.
    const voice = new Float32Array(n).map((_, i) => {
      if (i < 5 * SR || i >= 7 * SR) return 0;
      const env = Math.max(0, Math.sin((2 * Math.PI * 4 * i) / SR));
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * 150 * h * i) / SR) / h;
      return 0.25 * env * v;
    });
    const mic = echo.map((e, i) => e + voice[i]! + 0.003 * rand());
    writeFileSync(join(dir, 'mic.raw'), pcm(mic));
    writeFileSync(join(dir, 'ref.raw'), pcm(music));

    const run = spawnSync(exe, [
      'aec-selftest',
      join(dir, 'mic.raw'),
      join(dir, 'ref.raw'),
      join(dir, 'out.raw'),
    ]);
    const result = JSON.parse(run.stdout.toString()) as { ok: boolean; error?: string };
    if (!result.ok && /not registered|0x80040154/i.test(result.error ?? '')) {
      // Windows Server without Media Foundation (some CI images) has no Voice Capture DSP.
      unavailable = result.error!;
      console.warn(`Skipped: Windows' echo canceller isn't installed here (${unavailable}).`);
      return;
    }
    expect(result).toEqual({ ok: true });

    const bytes = readFileSync(join(dir, 'out.raw'));
    const out = new Float32Array(bytes.length / 2).map((_, i) => bytes.readInt16LE(i * 2) / 32768);
    const power = (x: Float32Array, from: number, to: number) => {
      let sum = 0;
      for (let i = from * SR; i < to * SR; i++) sum += (x[i] ?? 0) ** 2;
      return sum / ((to - from) * SR);
    };
    const db = (ratio: number) => 10 * Math.log10(ratio);

    // Echo alone, after the canceller has had a second to adapt: at least 20 dB quieter.
    expect(db(power(mic, 1, 5) / power(out, 1, 5))).toBeGreaterThan(20);
    expect(db(power(mic, 7, 8) / power(out, 7, 8))).toBeGreaterThan(20);
    // With the voice: the output is about as loud as the voice alone (not the echo)…
    expect(Math.abs(db(power(out, 5, 7) / power(voice, 5, 7)))).toBeLessThan(3);
    // …and it is the voice: strongly correlated with it (the output lags up to one 10 ms frame).
    let best = 0;
    for (let lag = 0; lag <= 320; lag += 4) {
      let xy = 0;
      let xx = 0;
      let yy = 0;
      for (let i = 5 * SR; i < 7 * SR; i++) {
        const x = voice[i]!;
        const y = out[i + lag] ?? 0;
        xy += x * y;
        xx += x * x;
        yy += y * y;
      }
      best = Math.max(best, xy / Math.sqrt(xx * yy));
    }
    expect(best).toBeGreaterThan(0.8);
  }, 60_000);
});
