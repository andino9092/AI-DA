import { describe, expect, it } from 'vitest';
import { grade } from '../../evals/graders';
import { MeteredProvider, runTask } from '../../evals/harness';
import { renderReport } from '../../evals/report';
import { tasks } from '../../evals/tasks';
import type { EvalTask } from '../../evals/types';
import { ProviderError } from '../../src/main/providers/llm/types';
import { FakeProvider } from '../main/fakes';

const call = (name: string, args: Record<string, unknown>) => ({
  text: '',
  toolCalls: [{ id: `${name}-1`, name, args }],
});

describe('eval dataset', () => {
  it('has unique task ids', () => {
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Keeps the dataset honest for free: commands the local parser should handle really are handled
  // locally and pass their rules, with no model and no quota.
  const local = tasks.filter(
    (t) =>
      t.expect.routes?.length === t.say.length && t.expect.routes.every((r) => r === 'instant'),
  );
  it.each(local.map((t) => [t.id, t] as const))('%s passes without a model', async (_id, task) => {
    const { run, world } = await runTask(task, null);
    expect(grade(task, run, world).failed).toEqual([]);
    expect(run.llmCalls).toBe(0);
  });
});

describe('eval harness', () => {
  const task: EvalTask = {
    id: 'scripted',
    category: 'single',
    say: ['make it properly quiet in here'],
    expect: {
      routes: ['llm'],
      tools: ['set_volume'],
      maxLlmCalls: 1,
      state: (w) => w.pc.volume.level === 20,
    },
  };

  it('runs the real tools on the simulated PC and measures the model', async () => {
    const fake = new FakeProvider('gemini', [call('set_volume', { level: 20 })]);
    const provider = new MeteredProvider(fake);
    const { run, world } = await runTask(task, provider);

    expect(grade(task, run, world)).toEqual({ pass: true, failed: [] });
    expect(world.pc.volume.level).toBe(20);
    expect(run.turns[0]).toMatchObject({ route: 'llm', reply: 'Volume set to 20%.' });
    expect(run.toolCalls).toEqual([
      { name: 'set_volume', args: { level: 20 }, ok: true, followUp: false },
    ]);
    expect(run.llmCalls).toBe(1);
    expect(run.requestChars).toBeGreaterThan(0);
    expect(run.toolsOffered[0]).toContain('set_volume');
  });

  it('names the rules that failed', async () => {
    // The model does the wrong thing: mutes instead of lowering the volume.
    const fake = new FakeProvider('gemini', [call('set_mute', { muted: true })]);
    const { run, world } = await runTask(task, new MeteredProvider(fake));
    expect(grade(task, run, world)).toEqual({
      pass: false,
      failed: ['tools: set_volume', 'state'],
    });
  });

  it('answers confirmations as the task says and records them', async () => {
    const risky: EvalTask = {
      id: 'declined',
      category: 'risky',
      say: ['get rid of spotify for today'],
      approve: false,
      expect: { confirms: true, state: (w) => w.pc.actions.length === 0 },
    };
    const fake = new FakeProvider('gemini', [call('close_app', { name: 'Spotify' })]);
    const { run, world } = await runTask(risky, new MeteredProvider(fake));
    expect(run.confirms).toEqual([{ summary: 'Close Spotify', approved: false }]);
    expect(grade(risky, run, world).pass).toBe(true);
  });

  it('catches a sensitive value in what was sent, and passes when it is scrubbed', async () => {
    const card = '4111 1111 1111 1111';
    const privacy: EvalTask = {
      id: 'card',
      category: 'privacy',
      say: [`which bank issues the card ${card}?`],
      expect: { neverSent: [card] },
    };
    const fake = new FakeProvider('gemini', [{ text: "I can't tell.", toolCalls: [] }]);
    const { run, world } = await runTask(privacy, new MeteredProvider(fake));
    expect(run.sent[0]).toContain('[CARD_1]');
    expect(grade(privacy, run, world).pass).toBe(true);

    run.sent.push(`leaked ${card}`);
    expect(grade(privacy, run, world).failed).toEqual(['neverSent']);
  });

  it('waits out a rate limit, then carries on', async () => {
    const waits: number[] = [];
    const fake = new FakeProvider('groq', [
      new ProviderError('rate_limit', 'slow down', 7000, 429),
      call('set_volume', { level: 20 }),
    ]);
    const provider = new MeteredProvider(fake, { sleep: async (ms) => void waits.push(ms) });
    const { run, world } = await runTask(task, provider);
    expect(waits).toEqual([7000]);
    expect(grade(task, run, world).pass).toBe(true);
    // One round trip as far as the agent is concerned, however often it was retried.
    expect(run.llmCalls).toBe(1);
  });

  it('grades a request the provider refused over a bad tool call as a failure', async () => {
    const fake = new FakeProvider('groq', [
      new ProviderError('bad_request', 'Groq: 400 tool_use_failed', undefined, 400),
    ]);
    const { run, world } = await runTask(task, new MeteredProvider(fake));
    expect(run.error).toBeUndefined();
    expect(grade(task, run, world).failed).toContain('invalid tool call (request rejected)');
  });

  it('marks a run as broken when the model cannot be reached, instead of grading it', async () => {
    const fake = new FakeProvider('gemini', [new ProviderError('auth', 'bad key', undefined, 401)]);
    const { run, world } = await runTask(task, new MeteredProvider(fake));
    expect(run.error).toMatch(/rejected its API key/);
    expect(grade(task, run, world).pass).toBe(false);

    const report = renderReport(
      [
        {
          model: 'gemini:test',
          results: [{ task, runs: [{ run, grade: grade(task, run, world) }] }],
        },
      ],
      new Date(0),
    );
    expect(report).toContain('| gemini:test | – (0/0) |');
    expect(report).toContain('| scripted | single | 0/0 |');
  });
});
