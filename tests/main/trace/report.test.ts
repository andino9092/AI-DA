import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  percentile,
  readTraces,
  readVoice,
  recentCommands,
  render,
  renderCommands,
  renderVoice,
  summarize,
  summarizeVoice,
  type LoggedTrace,
  type LoggedVoice,
} from '../../../scripts/trace-report.mjs';
import { tempDir } from '../fakes';

const base = { type: 'trace', source: 'voice', ok: true } as const;

const traces: LoggedTrace[] = [
  {
    ...base,
    ts: '2026-11-12T10:00:00.000Z',
    requestId: 'a',
    route: 'instant',
    totalMs: 600,
    spans: [
      { name: 'stt', audioSeconds: 1.2, reused: false, at: 0, ms: 200 },
      { name: 'tool', tool: 'set_volume', ok: true, at: 210, ms: 40 },
      { name: 'tts', at: 260, ms: 340 },
    ],
  },
  {
    ...base,
    ts: '2026-11-12T10:05:00.000Z',
    requestId: 'b',
    source: 'palette',
    route: 'llm',
    totalMs: 9000,
    spans: [
      {
        name: 'llm',
        provider: 'gemini',
        model: 'flash',
        toolsOffered: 12,
        at: 0,
        ms: 500,
        error: 'unavailable',
      },
      {
        name: 'llm',
        provider: 'groq',
        model: 'qwen',
        toolsOffered: 12,
        at: 500,
        ms: 700,
        inputTokens: 3000,
        outputTokens: 50,
      },
      { name: 'confirm', approved: true, at: 1250, ms: 7000 },
      { name: 'tool', tool: 'close_app', ok: true, at: 1250, ms: 7100 },
    ],
  },
  {
    ...base,
    ts: '2026-11-13T09:00:00.000Z',
    requestId: 'c',
    route: 'llm',
    ok: false,
    totalMs: 1500,
    spans: [
      {
        name: 'llm',
        provider: 'groq',
        model: 'qwen',
        toolsOffered: 20,
        at: 0,
        ms: 900,
        inputTokens: 5000,
        outputTokens: 10,
      },
      { name: 'tool', tool: 'open_app', ok: false, at: 900, ms: 10 },
    ],
  },
];

describe('trace report', () => {
  it('finds percentiles', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it('summarises routes, stages, model use and failures', () => {
    const s = summarize(traces);
    expect(s).toMatchObject({ requests: 3, failed: 1, voice: 2 });
    // The 7 s spent waiting for a yes is not counted against the request.
    expect(s.routes).toEqual({
      instant: { count: 1, median: 600, p95: 600 },
      llm: { count: 2, median: 1500, p95: 2000 },
    });
    // Only answered model calls count toward model speed.
    expect(s.stages.llm).toEqual({ count: 2, median: 700, p95: 900 });
    expect(s.stages.stt.count).toBe(1);
    expect(s.llmCallsPerRequest).toBe(1.5);
    expect(s.inputTokensPerCall).toBe(4000);
    expect(s.models).toEqual({
      'gemini:flash': { requests: 1, failed: 1, inputTokens: 0, outputTokens: 0 },
      'groq:qwen': { requests: 2, failed: 0, inputTokens: 8000, outputTokens: 60 },
    });
    expect(s.failures).toEqual({ 'gemini: unavailable': 1 });
    expect(s.toolFailures).toEqual({ open_app: 1 });
    expect(s.perDay).toEqual({
      '2026-11-12': { requests: 2, llmRequests: 2, tokens: 3050 },
      '2026-11-13': { requests: 1, llmRequests: 1, tokens: 5010 },
    });
  });

  it('renders a readable report, and says so when there is nothing yet', () => {
    const text = render(summarize(traces), 7);
    expect(text).toContain('3 requests (2 spoken, 1 typed); 1 failed.');
    expect(text).toContain('instant (no AI)');
    expect(text).toContain('Speech to text');
    expect(text).toContain('groq:qwen');
    expect(text).toContain('AI gemini: unavailable');
    expect(render(summarize([]), 7)).toMatch(/No requests traced/);
  });

  it('summarises voice diagnostics: outcomes, voice scores and lost commands', () => {
    const wake = { type: 'heard', mode: 'wake', seconds: 1, peakDb: -12 } as const;
    const heard: LoggedVoice[] = [
      { ...wake, outcome: 'not addressed', wakeMatched: false, sttMs: 200, words: 7 },
      {
        ...wake,
        outcome: 'rejected: voice',
        wakeMatched: true,
        voiceScore: 0.41,
        threshold: 0.45,
        sttMs: 220,
        words: 2,
      },
      {
        ...wake,
        outcome: 'rejected: voice',
        wakeMatched: true,
        voiceScore: 0.2,
        threshold: 0.45,
        sttMs: 240,
        words: 2,
      },
      {
        ...wake,
        outcome: 'wake only',
        wakeMatched: true,
        voiceScore: 0.7,
        threshold: 0.45,
        sttMs: 260,
        words: 2,
      },
      {
        type: 'heard',
        mode: 'command',
        outcome: 'accepted',
        seconds: 0.5,
        peakDb: -10,
        sttMs: 300,
        words: 1,
      },
      { type: 'heard', mode: 'command', outcome: 'timeout' },
    ];
    const s = summarizeVoice(heard);
    expect(s.heard).toBe(6);
    expect(s.outcomes).toEqual({
      'not addressed': 1,
      'rejected: voice': 2,
      'wake only': 1,
      accepted: 1,
      timeout: 1,
    });
    expect(s.voice).toEqual({
      checked: 3,
      rejected: 2,
      nearMisses: 1,
      lowest: 0.2,
      median: 0.41,
      highest: 0.7,
      threshold: 0.45,
    });
    expect(s.commands).toEqual({ listened: 2, accepted: 1, timeouts: 1, empty: 0, veryShort: 1 });

    const text = renderVoice(s, 7);
    expect(text).toContain('"Hey Aida" heard, voice did not match');
    expect(text).toContain('Checked 3 times; 2 rejected (1 within 0.10 of the threshold).');
    expect(text).toContain('1 understood commands were only one or two words');
    expect(renderVoice(summarizeVoice([]), 7)).toMatch(/Record voice diagnostics/);
  });

  it('reads voice diagnostics from their own files', () => {
    const dir = join(tempDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'voice-2026-11-13.jsonl'),
      `{"type":"heard","mode":"wake","outcome":"not addressed"}\n{"type":"trace","spans":[]}\n`,
    );
    writeFileSync(join(dir, 'traces-2026-11-13.jsonl'), `{"type":"heard","outcome":"accepted"}\n`);
    expect(readVoice(dir, 7, new Date('2026-11-13T12:00:00Z'))).toEqual([
      { type: 'heard', mode: 'wake', outcome: 'not addressed' },
    ]);
  });

  it('lists what was heard and what was done about it', () => {
    const commands = recentCommands([
      {
        ts: '2026-11-14T22:39:43.000Z',
        type: 'command',
        requestId: 'r1',
        text: 'minimize zen and move spotify',
      },
      {
        type: 'tool',
        requestId: 'r1',
        tool: 'window_action',
        ok: false,
        summary: 'minimize zen and move spotify',
      },
      { type: 'route', requestId: 'r1', route: 'llm' },
      { type: 'tool', requestId: 'r1', tool: 'window_action', ok: true, summary: 'minimize zen' },
      { type: 'reply', requestId: 'r1', text: 'Minimized Zen.' },
      {
        ts: '2026-11-14T22:40:00.000Z',
        type: 'command',
        requestId: 'r2',
        text: 'close this court',
      },
      { type: 'confirm', requestId: 'r2', summary: 'Close this court', approved: false },
      { type: 'route', requestId: 'r2', route: 'instant' },
      { type: 'reply', requestId: 'r2', text: "Okay, I won't do that." },
      { type: 'panic' },
    ]);
    expect(commands.map((c) => c.heard)).toEqual([
      'minimize zen and move spotify',
      'close this court',
    ]);
    const text = renderCommands(commands);
    expect(text).toContain('22:39:43  heard: "minimize zen and move spotify"');
    expect(text).toContain('handled by: instant failed, then AI');
    expect(text).toContain('FAILED: minimize zen and move spotify (window_action)');
    expect(text).toContain('did: minimize zen (window_action)');
    expect(text).toContain('you declined 1 confirmation(s)');
    expect(recentCommands(commands as never, 1)).toEqual([]);
    expect(renderCommands([])).toMatch(/No commands/);
  });

  it('reads only recent trace files and skips broken lines', () => {
    const dir = join(tempDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    const line = (t: LoggedTrace) => JSON.stringify(t);
    writeFileSync(join(dir, 'traces-2026-11-01.jsonl'), `${line(traces[0]!)}\n`);
    writeFileSync(
      join(dir, 'traces-2026-11-12.jsonl'),
      `${line(traces[0]!)}\n${line(traces[1]!)}\n{"type":"tr`,
    );
    writeFileSync(join(dir, 'traces-2026-11-13-2.jsonl'), `${line(traces[2]!)}\n`);
    writeFileSync(join(dir, 'actions-2026-11-13.jsonl'), `{"type":"command"}\n`);
    const read = readTraces(dir, 7, new Date('2026-11-13T12:00:00Z'));
    expect(read.map((t) => t.requestId)).toEqual(['a', 'b', 'c']);
    expect(readTraces(join(dir, 'missing'), 7)).toEqual([]);
  });
});
