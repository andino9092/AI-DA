import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore, memoryTools } from '../../../src/main/memory/memory';
import { matchRoutine, routineTools } from '../../../src/main/agent/routines';
import { detectSensitive } from '../../../src/main/privacy/detectors';
import type { Routine } from '../../../src/shared/settings';
import type { AnyTool, ToolContext } from '../../../src/main/tools/types';
import { tempDir } from '../fakes';

const ctx = (): ToolContext => ({
  activeWindow: null,
  signal: new AbortController().signal,
  confirm: async () => true,
});
const tool = (tools: AnyTool[], name: string) => tools.find((t) => t.name === name)!;
const run = (t: AnyTool, args: unknown) => t.run(t.input.parse(args), ctx());

const sensitive = (text: string) =>
  detectSensitive(text, { maskContactInfo: true, customValues: ['221B Baker Street'] }).length > 0;

describe('MemoryStore', () => {
  it('remembers facts across restarts, without duplicates', () => {
    const file = join(tempDir(), 'memory.json');
    const memory = new MemoryStore(file, sensitive);
    memory.remember('I take my coffee black.');
    memory.remember('i take my coffee black');
    memory.setNickname('My Editor', 'Visual Studio Code');
    const again = new MemoryStore(file, sensitive);
    expect(again.snapshot().facts.map((f) => f.text)).toEqual(['I take my coffee black']);
    expect(again.snapshot().nicknames).toMatchObject([
      { nickname: 'my editor', means: 'Visual Studio Code' },
    ]);
  });

  it('refuses private details', () => {
    const memory = new MemoryStore(join(tempDir(), 'm.json'), sensitive);
    for (const fact of [
      'my card is 4111 1111 1111 1111',
      'my password is hunter2!Secret',
      'my email is sam@example.com',
      'I live at 221B Baker Street',
      'my PIN is [PASSWORD_1]',
    ])
      expect(() => memory.remember(fact), fact).toThrow(/private details/);
    expect(memory.snapshot().facts).toEqual([]);
  });

  it('expands nicknames as whole words, longest first', () => {
    const memory = new MemoryStore(join(tempDir(), 'm.json'), sensitive);
    memory.setNickname('the game', 'Counter-Strike 2');
    memory.setNickname('game', 'Minecraft');
    expect(memory.expandNicknames('open the game')).toBe('open Counter-Strike 2');
    expect(memory.expandNicknames('close game')).toBe('close Minecraft');
    expect(memory.expandNicknames('open gamebar')).toBe('open gamebar');
  });

  it('forgets the best match only', () => {
    const memory = new MemoryStore(join(tempDir(), 'm.json'), sensitive);
    memory.remember('I take my coffee black');
    memory.remember('My sister is called Mia');
    expect(memory.forget('coffee')).toEqual(['I take my coffee black']);
    expect(memory.forget('weather')).toEqual([]);
    expect(memory.snapshot().facts.map((f) => f.text)).toEqual(['My sister is called Mia']);
  });

  it('keeps the facts sent to the AI short', () => {
    const memory = new MemoryStore(join(tempDir(), 'm.json'), sensitive);
    for (let i = 0; i < 40; i++) memory.remember(`fact number ${i} ${'x'.repeat(60)}`);
    const facts = memory.promptFacts();
    expect(facts.join('').length).toBeLessThanOrEqual(1500);
    expect(facts[0]).toContain('fact number 39');
  });

  it('has tools that explain refusals', async () => {
    const memory = new MemoryStore(join(tempDir(), 'm.json'), sensitive);
    const tools = memoryTools(memory);
    expect((await run(tool(tools, 'remember'), { fact: 'I like jazz' })).speak).toBe(
      "Got it, I'll remember that.",
    );
    expect(
      (await run(tool(tools, 'remember'), { fact: 'my card is 4111 1111 1111 1111' })).ok,
    ).toBe(false);
    expect((await run(tool(tools, 'list_memories'), {})).data).toEqual({
      facts: ['I like jazz'],
      nicknames: [],
    });
    expect((await run(tool(tools, 'forget'), { what: 'jazz' })).speak).toBe('Okay, forgotten.');
  });
});

describe('routines', () => {
  const routines: Routine[] = [
    { name: 'Gaming mode', steps: ['open steam'] },
    { name: 'Good morning', steps: ['what is the weather'] },
  ];

  it.each([
    ['gaming mode', 'Gaming mode'],
    ['Gaming.', 'Gaming mode'],
    ['start gaming mode', 'Gaming mode'],
    ['hey aida, activate the gaming mode please', 'Gaming mode'],
    ['good morning', 'Good morning'],
    ['run my good morning routine', 'Good morning'],
    ["it's good morning", 'Good morning'],
  ])('"%s" → %s', (text, name) => {
    expect(matchRoutine(text, routines)?.name).toBe(name);
  });

  it.each(['open steam', 'good morning aida how are you', ''])('ignores "%s"', (text) => {
    expect(matchRoutine(text, routines)).toBeNull();
  });

  it('creates, replaces and deletes routines', async () => {
    let saved: Routine[] = [];
    const tools = routineTools({ list: () => saved, save: (r) => (saved = r) });
    expect(
      (
        await run(tool(tools, 'create_routine'), {
          name: 'Gaming mode',
          steps: ['open steam', 'set volume to 40'],
        })
      ).speak,
    ).toBe('Saved Gaming mode. Say "Gaming mode" to run its 2 steps.');
    await run(tool(tools, 'create_routine'), { name: 'gaming', steps: ['open steam'] });
    expect(saved).toEqual([{ name: 'gaming', steps: ['open steam'] }]);
    expect((await run(tool(tools, 'delete_routine'), { name: 'Gaming Mode' })).ok).toBe(true);
    expect(saved).toEqual([]);
  });
});
