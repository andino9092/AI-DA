import { describe, expect, it, vi } from 'vitest';
import type { AssistantState } from '../../../src/shared/assistant';
import type { AudioCommand, HeardEvent, OverlayState } from '../../../src/shared/voice';
import { parseYesNo, VoiceController } from '../../../src/main/voice/voice-controller';

const samples = new Float32Array(1600);

function setup(options: {
  transcripts: string[];
  reply?: string;
  speak?: boolean;
  canListen?: boolean;
  wakeWord?: boolean;
  monitoring?: boolean;
}) {
  const transcripts = [...options.transcripts];
  const commands: string[] = [];
  const audio: AudioCommand[] = [];
  const overlay: OverlayState[] = [];
  const states: (AssistantState | null)[] = [];
  const spoken: string[] = [];
  const heard: HeardEvent[] = [];
  let finishSpeech: (() => void) | null = null;

  const controller = new VoiceController({
    stt: { transcribe: async () => transcripts.shift() ?? '' },
    speak: async (text, onChunk) => {
      spoken.push(text);
      onChunk(new Float32Array(10), 24_000);
    },
    handleCommand: async (text) => {
      commands.push(text);
      return options.reply ?? 'Done.';
    },
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
    finish: () => finishSpeech?.(),
  };
}

describe('VoiceController', () => {
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
    expect(t.audio.filter((c) => c.type === 'config').at(-1)).toMatchObject({ hold: false });
    expect(t.audio.at(-1)).toEqual({ type: 'flush' });
    spy.mockRestore();
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
