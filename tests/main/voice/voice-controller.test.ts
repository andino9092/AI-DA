import { describe, expect, it, vi } from 'vitest';
import type { AssistantState } from '../../../src/shared/assistant';
import type { AudioCommand, HeardEvent, OverlayState } from '../../../src/shared/voice';
import { Tracer, type TraceEntry } from '../../../src/main/trace/tracer';
import type { VoiceDiagnostic } from '../../../src/main/voice/diagnostics';
import { parseYesNo, VoiceController } from '../../../src/main/voice/voice-controller';

const samples = new Float32Array(1600);

function setup(options: {
  transcripts: string[];
  reply?: string;
  speak?: boolean;
  canListen?: boolean;
  wakeWord?: boolean;
  monitoring?: boolean;
  duck?: (on: boolean) => void;
  speaker?: { enabled(): boolean; match(samples: Float32Array): Promise<number | null> };
  tracer?: Tracer;
  paused?: () => boolean;
  diagnose?: (diagnostic: VoiceDiagnostic) => void;
}) {
  const transcripts = [...options.transcripts];
  const commands: string[] = [];
  const audio: AudioCommand[] = [];
  const overlay: OverlayState[] = [];
  const states: (AssistantState | null)[] = [];
  const spoken: string[] = [];
  const heard: HeardEvent[] = [];
  let finishSpeech: (() => void) | null = null;

  const sttCalls: (AbortSignal | undefined)[] = [];
  const controller = new VoiceController({
    stt: {
      transcribe: async (_samples, signal) => {
        sttCalls.push(signal);
        return transcripts.shift() ?? '';
      },
    },
    speak: async (text, onChunk) => {
      spoken.push(text);
      onChunk(new Float32Array(10), 24_000);
    },
    handleCommand: async (text, _activeWindow, trace) => {
      commands.push(text);
      trace?.routed('instant');
      return options.reply ?? 'Done.';
    },
    tracer: options.tracer,
    paused: options.paused,
    diagnose: options.diagnose,
    foregroundWindow: async () => 42,
    audio: (c) => {
      audio.push(c);
      if (c.type === 'end-of-speech')
        finishSpeech = () => controller.onAudioEvent({ type: 'playback-finished', id: c.id });
    },
    overlay: (s) => overlay.push(s),
    setState: (s) => states.push(s),
    settings: () => ({
      listening: true,
      wakeWord: options.wakeWord ?? true,
      speakReplies: options.speak ?? true,
      deviceId: null,
      sensitivity: 'normal',
    }),
    monitoring: () => options.monitoring ?? false,
    onHeard: (h) => heard.push(h),
    canListen: () => options.canListen ?? true,
    canSpeak: () => true,
    duck: options.duck,
    speaker: options.speaker,
  });

  const say = async (mode: 'wake' | 'command' = 'wake') => {
    controller.onUtterance({ mode, samples });
    await controller.idle();
  };
  const modes = () =>
    audio.filter((c) => c.type === 'config').map((c) => (c as { mode: string }).mode);
  return {
    controller,
    say,
    commands,
    audio,
    overlay,
    states,
    spoken,
    heard,
    modes,
    sttCalls,
    finish: () => finishSpeech?.(),
  };
}

describe('VoiceController', () => {
  it('reads a notification only while idle, after its soft chime', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ transcripts: [] });
      expect(t.controller.free).toBe(true);
      expect(t.controller.notify('Email from Sam.')).toBe(true);
      expect(t.audio).toContainEqual({ type: 'chime', chime: 'notify' });
      // Busy talking: the next one has to wait.
      expect(t.controller.free).toBe(false);
      expect(t.controller.notify('Another one.')).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(t.spoken).toEqual(['Email from Sam.']);
      t.finish();
      expect(t.controller.free).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't read notifications aloud with spoken replies off", () => {
    const t = setup({ transcripts: [], speak: false });
    expect(t.controller.notify('Email from Sam.')).toBe(false);
    expect(t.audio).toEqual([]);
  });

  it('runs "Hey Aida, <command>" in one go and speaks the reply', async () => {
    const t = setup({ transcripts: ['Hey Aida, pause the music.'], reply: 'Okay.' });
    await t.say();
    expect(t.commands).toEqual(['pause the music.']);
    expect(t.spoken).toEqual(['Okay.']);
    expect(t.audio.some((c) => c.type === 'play')).toBe(true);
    expect(t.states).toContain('thinking');
    expect(t.states).toContain('speaking');
    t.finish();
    expect(t.states.at(-1)).toBeNull();
    expect(t.modes().at(-1)).toBe('wake');
  });

  it('hides the Listening pill once a voice sample is recorded', async () => {
    const t = setup({ transcripts: [] });
    const sample = t.controller.recordSample();
    expect(t.overlay.at(-1)).toEqual({ phase: 'listening' });
    t.controller.onUtterance({ mode: 'command', samples });
    expect(await sample).toBe(samples);
    expect(t.overlay.at(-1)).toEqual({ phase: 'hidden' });
    expect(t.states.at(-1)).toBeNull();
    expect(t.modes().at(-1)).toBe('wake');
    // A sample is never transcribed or run.
    expect(t.sttCalls).toEqual([]);
    expect(t.commands).toEqual([]);
  });

  it('hears "Hey Aida" but runs nothing while voice samples are being recorded', async () => {
    let paused = true;
    const t = setup({
      transcripts: ['Hey Aida, open Spotify.', 'Hey Aida, open Spotify.'],
      paused: () => paused,
    });
    await t.say();
    expect(t.commands).toEqual([]);
    expect(t.spoken).toEqual([]);
    paused = false;
    await t.say();
    expect(t.commands).toEqual(['open Spotify.']);
  });

  it('keeps listening when "Hey Aida" is said again instead of a command', async () => {
    const t = setup({
      transcripts: ['Hey Aida.', 'Hey Ada,', 'Hey Aida, open spotify'],
      speak: false,
    });
    await t.say();
    await t.say('command');
    expect(t.commands).toEqual([]);
    expect(t.modes().at(-1)).toBe('command');
    // A repeated name in front of the command is dropped, not sent to the assistant.
    await t.say('command');
    expect(t.commands).toEqual(['open spotify']);
  });

  it('reports what became of each utterance, in numbers only', async () => {
    const seen: VoiceDiagnostic[] = [];
    const t = setup({
      transcripts: [
        'So anyway, I told him no.',
        'Hey Aida, pause the music.',
        'Hey Aida.',
        'Hey Aida.',
        '',
      ],
      speak: false,
      diagnose: (d) => seen.push(d),
    });
    await t.say(); // not for Aida
    await t.say(); // a whole command
    await t.say(); // the name alone: starts listening
    await t.say('command'); // the name again
    await t.say('command'); // nothing usable
    t.controller.pushToTalk();
    t.controller.onAudioEvent({ type: 'command-timeout' });

    expect(seen.map((d) => [d.mode, d.outcome])).toEqual([
      ['wake', 'not addressed'],
      ['wake', 'accepted'],
      ['wake', 'wake only'],
      ['command', 'repeated wake'],
      ['command', 'empty'],
      ['command', 'timeout'],
    ]);
    expect(seen[0]).toMatchObject({ seconds: 0.1, wakeMatched: false, words: 6 });
    expect(seen[1]).toMatchObject({ wakeMatched: true, words: 5 });
    expect(seen[1]!.sttMs).toBeGreaterThanOrEqual(0);
    // Not a word of what was said.
    expect(JSON.stringify(seen)).not.toMatch(/anyway|pause|music|Aida/i);
  });

  it('reports the voice score when "Hey Aida" is rejected for the wrong voice', async () => {
    const seen: VoiceDiagnostic[] = [];
    const t = setup({
      transcripts: ['Hey Aida, pause the music.'],
      speaker: { enabled: () => true, match: async () => 0.412 },
      diagnose: (d) => seen.push(d),
    });
    await t.say();
    expect(t.commands).toEqual([]);
    expect(seen).toEqual([
      expect.objectContaining({
        outcome: 'rejected: voice',
        wakeMatched: true,
        voiceScore: 0.41,
        threshold: 0.45,
      }),
    ]);
  });

  it('traces a spoken command from transcription to the first audio of the reply', async () => {
    const entries: TraceEntry[] = [];
    const tracer = new Tracer((e) => entries.push(e));
    const t = setup({ transcripts: ['Hey Aida, pause the music.'], reply: 'Okay.', tracer });
    await t.say();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'voice', route: 'instant', ok: true });
    expect(entries[0]!.spans.map((s) => s.name)).toEqual(['stt', 'tts']);
    // 1,600 samples at 16 kHz.
    expect(entries[0]!.spans[0]).toMatchObject({ audioSeconds: 0.1, reused: false });
  });

  it('traces nothing for speech that is not addressed to Aida', async () => {
    const entries: TraceEntry[] = [];
    const t = setup({
      transcripts: ['So anyway, I told him no.'],
      tracer: new Tracer((e) => entries.push(e)),
    });
    await t.say();
    expect(entries).toEqual([]);
  });

  it('ends the trace when the reply is only shown, not spoken', async () => {
    const entries: TraceEntry[] = [];
    const t = setup({
      transcripts: ['Hey Aida, pause the music.'],
      speak: false,
      tracer: new Tracer((e) => entries.push(e)),
    });
    await t.say();
    expect(entries[0]!.spans.map((s) => s.name)).toEqual(['stt']);
  });

  it('drops speech that is not addressed to Aida, without calling the assistant', async () => {
    const t = setup({ transcripts: ['so anyway I told her the password is fish'] });
    await t.say();
    expect(t.commands).toEqual([]);
    expect(t.overlay).toEqual([]);
  });

  it('"Hey Aida" alone opens the mic for the next sentence', async () => {
    const t = setup({ transcripts: ['Hey Aida.', 'open spotify'], speak: false });
    await t.say();
    expect(t.audio).toContainEqual({ type: 'chime', chime: 'listen' });
    expect(t.modes().at(-1)).toBe('command');
    await t.say('command');
    expect(t.commands).toEqual(['open spotify']);
  });

  it('push-to-talk listens for a command and stops Aida talking', async () => {
    const t = setup({
      transcripts: ['Hey Aida, tell me a long story', 'volume 20'],
      reply: 'Once upon a time.',
    });
    await t.say();
    t.controller.pushToTalk();
    expect(t.audio).toContainEqual({ type: 'stop-playback' });
    expect(t.modes().at(-1)).toBe('command');
    await t.say('command');
    expect(t.commands).toEqual(['tell me a long story', 'volume 20']);
  });

  it('"Hey Aida, stop" interrupts instead of becoming a command', async () => {
    const t = setup({
      transcripts: ['Hey Aida, read me the news', 'Hey Aida, stop.'],
      reply: 'Here is the news.',
    });
    await t.say();
    await t.say();
    expect(t.commands).toEqual(['read me the news']);
    expect(t.audio).toContainEqual({ type: 'stop-playback' });
  });

  it('a question from Aida opens the mic for the answer', async () => {
    const t = setup({
      transcripts: ['Hey Aida, open the editor', 'the second one'],
      reply: 'Which editor?',
    });
    await t.say();
    t.finish();
    expect(t.modes().at(-1)).toBe('command');
    await t.say('command');
    expect(t.commands).toEqual(['open the editor', 'the second one']);
  });

  it("says so when it didn't catch a command", async () => {
    const t = setup({ transcripts: [''] });
    t.controller.pushToTalk();
    await t.say('command');
    expect(t.overlay.at(-1)).toMatchObject({ phase: 'error', text: "Sorry, I didn't catch that." });
    expect(t.commands).toEqual([]);
  });

  it('keeps the microphone off until voice is installed', () => {
    const t = setup({ transcripts: [], canListen: false });
    t.controller.refresh();
    expect(t.modes()).toEqual(['off']);
    t.controller.pushToTalk();
    expect(t.overlay.at(-1)).toMatchObject({ phase: 'error' });
  });

  it('reports what was heard only while the mic check is open', async () => {
    const off = setup({ transcripts: ['Hey Aida, mute'] });
    await off.say();
    expect(off.heard).toEqual([]);

    const on = setup({ transcripts: ['so anyway', 'Hey Aida, mute'], monitoring: true });
    await on.say();
    await on.say();
    expect(on.heard.map((h) => [h.text, h.accepted])).toEqual([
      ['so anyway', false],
      ['Hey Aida, mute', true],
    ]);
    expect(on.heard[0]!.peakDb).toBe(-Infinity);
  });

  it('the mic check listens with the wake word off, but acts on nothing', async () => {
    const t = setup({ transcripts: ['Hey Aida, mute'], wakeWord: false, monitoring: true });
    t.controller.refresh();
    expect(t.modes().at(-1)).toBe('wake');
    await t.say();
    expect(t.commands).toEqual([]);
    expect(t.heard[0]!.accepted).toBe(false);

    const idle = setup({ transcripts: [], wakeWord: false });
    idle.controller.refresh();
    expect(idle.modes().at(-1)).toBe('off');
  });

  it('holding push-to-talk listens until release, then sends what was said', async () => {
    const t = setup({ transcripts: [] });
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    t.controller.pushToTalkDown();
    const holding = t.audio.filter((c) => c.type === 'config').at(-1);
    expect(holding).toMatchObject({ mode: 'command', hold: true });
    spy.mockReturnValue(now + 2000);
    t.controller.pushToTalkUp();
    // The recording is sent first, then hold is switched off (otherwise it would be dropped).
    expect(t.audio.slice(-2)).toMatchObject([{ type: 'flush' }, { type: 'config', hold: false }]);
    spy.mockRestore();
  });

  it('"I didn\'t hear anything" when push-to-talk was held in silence', () => {
    const t = setup({ transcripts: [] });
    t.controller.pushToTalkDown();
    t.controller.onAudioEvent({ type: 'no-speech' });
    expect(t.overlay.at(-1)).toMatchObject({ phase: 'error', text: "I didn't hear anything." });
    expect(t.modes().at(-1)).toBe('wake');
  });

  it('stops listening on its own if the key-up never arrives', () => {
    vi.useFakeTimers();
    try {
      const t = setup({ transcripts: [] });
      t.controller.pushToTalkDown();
      vi.advanceTimersByTime(26_000);
      expect(t.audio.some((c) => c.type === 'flush')).toBe(true);
      expect(t.audio.filter((c) => c.type === 'config').at(-1)).toMatchObject({ hold: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks to lower other sounds while listening and restores them after', async () => {
    const ducks: boolean[] = [];
    const t = setup({ transcripts: ['open spotify'], speak: false, duck: (on) => ducks.push(on) });
    t.controller.pushToTalk();
    expect(ducks).toEqual([true]);
    await t.say('command');
    expect(ducks.at(-1)).toBe(false);
  });

  it('a quick tap of push-to-talk still means "speak, then pause"', () => {
    const t = setup({ transcripts: [] });
    t.controller.pushToTalkDown();
    t.controller.pushToTalkUp();
    expect(t.audio.some((c) => c.type === 'flush')).toBe(false);
    expect(t.modes().at(-1)).toBe('command');
  });

  it('asks a confirmation out loud and hears the answer while the command waits', async () => {
    const t = setup({ transcripts: ['Yes, do it.'] });
    const answer = t.controller.confirm('Click “Send” in Discord');
    expect(answer).not.toBeNull();
    expect(t.spoken).toEqual(['Click “Send” in Discord?']);
    await Promise.resolve();
    t.finish();
    expect(t.modes().at(-1)).toBe('command');
    expect(t.overlay.at(-1)).toMatchObject({ phase: 'confirm' });
    t.controller.onUtterance({ mode: 'command', samples });
    await expect(answer).resolves.toBe(true);
  });

  it('anything but a clear yes is a no, and so is silence', async () => {
    const unclear = setup({ transcripts: ['purple'], speak: false });
    const first = unclear.controller.confirm('Close Discord')!;
    unclear.controller.onUtterance({ mode: 'command', samples });
    await expect(first).resolves.toBe(false);

    const silent = setup({ transcripts: [], speak: false });
    const second = silent.controller.confirm('Close Discord')!;
    silent.controller.onAudioEvent({ type: 'command-timeout' });
    await expect(second).resolves.toBe(false);
  });

  it('panic declines a pending question and stops talking', async () => {
    const t = setup({ transcripts: [], speak: false });
    const pending = t.controller.confirm('Send it')!;
    t.controller.panic();
    await expect(pending).resolves.toBe(false);
    expect(t.overlay.at(-1)).toMatchObject({ phase: 'reply', text: 'Stopped.' });
    expect(t.states.at(-1)).toBeNull();
  });

  it('can only confirm by voice when listening works', () => {
    const t = setup({ transcripts: [], canListen: false });
    expect(t.controller.confirm('Send it')).toBeNull();
  });

  it('reads yes and no', () => {
    expect(parseYesNo('Yes.')).toBe(true);
    expect(parseYesNo('Um, yeah')).toBe(true);
    expect(parseYesNo("No, don't.")).toBe(false);
    expect(parseYesNo('Cancel')).toBe(false);
    expect(parseYesNo('Maybe later')).toBeNull();
  });
});

describe('VoiceController: faster replies and loud rooms', () => {
  it('reuses the transcript started during the pause', async () => {
    const t = setup({ transcripts: ['Hey Aida, pause the music.'], speak: false });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 3, tentative: true });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 3, reuse: true });
    await t.controller.idle();
    expect(t.sttCalls).toHaveLength(1);
    expect(t.commands).toEqual(['pause the music.']);
  });

  it('drops the early transcript when the speaker went on', async () => {
    const t = setup({
      transcripts: ['Hey Aida, pause', 'Hey Aida, pause the music and turn it up'],
      speak: false,
    });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 4, tentative: true });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 4 });
    await t.controller.idle();
    expect(t.sttCalls).toHaveLength(2);
    expect(t.sttCalls[0]!.aborted).toBe(true);
    expect(t.commands).toEqual(['pause the music and turn it up']);
  });

  it('hears "Hey Aida" after song lyrics', async () => {
    const t = setup({
      transcripts: ['We will, we will rock you. Hey Aida, skip this song.'],
      speak: false,
    });
    await t.say();
    expect(t.commands).toEqual(['skip this song.']);
  });

  it('listens for the rest of a sentence cut from continuous sound', async () => {
    const t = setup({
      transcripts: ['rock you, rock you. Hey Aida, turn the', 'music down'],
      speak: false,
    });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 7, cut: true });
    await t.controller.idle();
    expect(t.modes().at(-1)).toBe('command');
    t.controller.onAudioEvent({ type: 'speech-start', mode: 'command' });
    await t.say('command');
    expect(t.commands).toEqual(['turn the music down']);
  });

  it('runs a complete command from a cut window when nothing more is said', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ transcripts: ['la la la. Hey Aida, pause the music.'], speak: false });
      t.controller.onUtterance({ mode: 'wake', samples, segment: 9, cut: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.commands).toEqual([]);
      await vi.advanceTimersByTimeAsync(1600);
      await t.controller.idle();
      expect(t.commands).toEqual(['pause the music.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores cut windows that are only music', async () => {
    const t = setup({ transcripts: ['we will, we will rock you'] });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 2, cut: true });
    await t.controller.idle();
    expect(t.modes()).not.toContain('command');
    expect(t.commands).toEqual([]);
  });
});

describe('VoiceController: only my voice', () => {
  const speaker = (score: number | null, enabled = true) => {
    const calls: number[] = [];
    return {
      calls,
      enabled: () => enabled,
      match: async (s: Float32Array) => {
        calls.push(s.length);
        return score;
      },
    };
  };

  it('ignores "Hey Aida" in someone else’s voice', async () => {
    const other = speaker(0.2);
    const t = setup({
      transcripts: ['Hey Aida, pause the music.'],
      speaker: other,
      monitoring: true,
    });
    await t.say();
    expect(t.commands).toEqual([]);
    expect(t.heard[0]).toMatchObject({ accepted: false, voiceMatch: 0.2, notYourVoice: true });
  });

  it('answers the owner, and speech too short to judge', async () => {
    for (const score of [0.8, null]) {
      const t = setup({
        transcripts: ['Hey Aida, pause the music.'],
        speaker: speaker(score),
        speak: false,
      });
      await t.say();
      expect(t.commands).toEqual(['pause the music.']);
    }
  });

  it('only checks the voice of wake phrases, and not when it is off', async () => {
    const owner = speaker(0.1);
    const t = setup({ transcripts: ['Hey Aida.', 'open spotify'], speaker: owner, speak: false });
    await t.say();
    // A low score blocked the bare "Hey Aida" too.
    expect(t.modes()).not.toContain('command');
    const off = speaker(0.1, false);
    const t2 = setup({ transcripts: ['Hey Aida.', 'open spotify'], speaker: off, speak: false });
    await t2.say();
    await t2.say('command');
    expect(t2.commands).toEqual(['open spotify']);
    expect(off.calls).toEqual([]);
    // Push-to-talk and follow-ups (command mode) are never checked.
    const pt = speaker(0.1);
    const t3 = setup({ transcripts: ['volume 20'], speaker: pt, speak: false });
    await t3.say('command');
    expect(t3.commands).toEqual(['volume 20']);
    expect(pt.calls).toEqual([]);
  });

  it('checks the voice during the pause, alongside the transcript', async () => {
    const owner = speaker(0.9);
    const t = setup({ transcripts: ['Hey Aida, pause the music.'], speaker: owner, speak: false });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 1, tentative: true });
    t.controller.onUtterance({ mode: 'wake', samples, segment: 1, reuse: true });
    await t.controller.idle();
    expect(owner.calls).toHaveLength(1);
    expect(t.commands).toEqual(['pause the music.']);
  });
});

describe('VoiceController: recording a voice sample', () => {
  it('returns the next utterance without transcribing or running it', async () => {
    const t = setup({ transcripts: ['should not be used'] });
    const recording = t.controller.recordSample();
    expect(t.modes().at(-1)).toBe('command');
    const heardSample = new Float32Array(32_000);
    t.controller.onUtterance({ mode: 'command', samples: heardSample });
    expect(await recording).toBe(heardSample);
    expect(t.sttCalls).toHaveLength(0);
    expect(t.commands).toEqual([]);
    expect(t.modes().at(-1)).toBe('wake');
  });

  it('gives up when nothing is said', async () => {
    const t = setup({ transcripts: [] });
    const recording = t.controller.recordSample();
    t.controller.onAudioEvent({ type: 'command-timeout' });
    expect(await recording).toBeNull();
  });
});
