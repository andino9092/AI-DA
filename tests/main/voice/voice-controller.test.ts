import { describe, expect, it } from 'vitest';
import type { AssistantState } from '../../../src/shared/assistant';
import type { AudioCommand, OverlayState } from '../../../src/shared/voice';
import { VoiceController } from '../../../src/main/voice/voice-controller';

const samples = new Float32Array(1600);

function setup(options: {
  transcripts: string[];
  reply?: string;
  speak?: boolean;
  canListen?: boolean;
}) {
  const transcripts = [...options.transcripts];
  const commands: string[] = [];
  const audio: AudioCommand[] = [];
  const overlay: OverlayState[] = [];
  const states: (AssistantState | null)[] = [];
  const spoken: string[] = [];
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
      wakeWord: true,
      speakReplies: options.speak ?? true,
      deviceId: null,
    }),
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
});
