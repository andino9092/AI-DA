import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { MemorySnapshot } from '@shared/memory';
import { defineTool } from '../tools/types';
import { matchScore, normalizeName } from '../util/fuzzy';
import { writeFileAtomic } from '../util/atomic-write';

const MAX_FACTS = 100;
const MAX_NICKNAMES = 50;
/** Only this much memory goes into each AI request, so it stays cheap. */
const PROMPT_BUDGET = 1500;

const fileSchema = z.object({
  version: z.literal(1),
  facts: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.number() })),
  nicknames: z.array(z.object({ id: z.string(), nickname: z.string(), means: z.string() })),
});

type MemoryFile = z.infer<typeof fileSchema>;

/** Placeholders the Privacy Guard put in: the value itself never reaches a tool unasked. */
const PLACEHOLDER = /\[[A-Z_]+_\d+\]/;

export class MemoryRefusedError extends Error {}

/**
 * Things the user asked Aida to remember ("I like jazz", "my editor means VS Code"). Kept in a
 * local file and never holds sensitive values: anything the Privacy Guard would mask is refused.
 */
export class MemoryStore {
  private data: MemoryFile;
  private readonly listeners = new Set<(snapshot: MemorySnapshot) => void>();

  constructor(
    private readonly file: string,
    /** True if the text holds anything the Privacy Guard would mask (cards, passwords, emails…). */
    private readonly isSensitive: (text: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
  }

  snapshot(): MemorySnapshot {
    return {
      facts: this.data.facts.map(({ id, text }) => ({ id, text })),
      nicknames: this.data.nicknames.map(({ id, nickname, means }) => ({ id, nickname, means })),
    };
  }

  onChanged(listener: (snapshot: MemorySnapshot) => void): void {
    this.listeners.add(listener);
  }

  /** Throws MemoryRefusedError for private details or a full memory. */
  remember(text: string): void {
    const clean = text.trim().replace(/[.!]+$/, '');
    this.check(clean);
    const key = normalizeName(clean);
    if (this.data.facts.some((f) => normalizeName(f.text) === key)) return;
    if (this.data.facts.length >= MAX_FACTS)
      throw new MemoryRefusedError('My memory is full. Remove something in Settings first.');
    this.data.facts.push({ id: randomUUID(), text: clean, createdAt: this.now() });
    this.save();
  }

  setNickname(nickname: string, means: string): void {
    const nick = nickname.trim().toLowerCase();
    const target = means.trim();
    this.check(`${nick} ${target}`);
    if (!normalizeName(nick) || !normalizeName(target))
      throw new MemoryRefusedError('I need both the nickname and what it means.');
    this.data.nicknames = this.data.nicknames.filter(
      (n) => normalizeName(n.nickname) !== normalizeName(nick),
    );
    if (this.data.nicknames.length >= MAX_NICKNAMES)
      throw new MemoryRefusedError('You have too many nicknames. Remove one in Settings first.');
    this.data.nicknames.push({ id: randomUUID(), nickname: nick, means: target });
    this.save();
  }

  /** Forgets the facts and nicknames that best match; returns what was removed. */
  forget(query: string): string[] {
    const q = query.trim();
    const scored = [
      ...this.data.facts.map((f) => ({ id: f.id, text: f.text, score: this.score(q, f.text) })),
      ...this.data.nicknames.map((n) => ({
        id: n.id,
        text: `${n.nickname} means ${n.means}`,
        score: Math.max(this.score(q, n.nickname), this.score(q, `${n.nickname} ${n.means}`)),
      })),
    ].filter((s) => s.score >= 0.6);
    if (scored.length === 0) return [];
    const best = Math.max(...scored.map((s) => s.score));
    // Everything that matches about as well as the best one ("forget my coffee order" can
    // match two coffee facts).
    const removed = scored.filter((s) => s.score >= best - 0.05);
    this.remove(removed.map((r) => r.id));
    return removed.map((r) => r.text);
  }

  remove(ids: string[]): void {
    const drop = new Set(ids);
    this.data.facts = this.data.facts.filter((f) => !drop.has(f.id));
    this.data.nicknames = this.data.nicknames.filter((n) => !drop.has(n.id));
    this.save();
  }

  clear(): void {
    this.data = { version: 1, facts: [], nicknames: [] };
    this.save();
  }

  /** "open my editor" → "open visual studio code", with the user's nicknames. */
  expandNicknames(text: string): string {
    let out = text;
    // Longest first, so "my old laptop" wins over "laptop".
    const sorted = [...this.data.nicknames].sort((a, b) => b.nickname.length - a.nickname.length);
    for (const { nickname, means } of sorted) {
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])${nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`,
        'giu',
      );
      out = out.replace(pattern, (_m, before: string) => `${before}${means}`);
    }
    return out;
  }

  /** The facts, newest first, cut to a small budget for the AI's instructions. */
  promptFacts(): string[] {
    const out: string[] = [];
    let used = 0;
    for (const fact of [...this.data.facts].reverse()) {
      if (used + fact.text.length > PROMPT_BUDGET) break;
      out.push(fact.text);
      used += fact.text.length;
    }
    return out;
  }

  private score(query: string, text: string): number {
    const q = normalizeName(query);
    const t = normalizeName(text);
    if (!q) return 0;
    if (t.includes(q)) return 0.95;
    return matchScore(q, t);
  }

  private check(text: string): void {
    if (PLACEHOLDER.test(text) || this.isSensitive(text))
      throw new MemoryRefusedError(
        "I don't keep private details like card numbers, passwords, account numbers, emails or phone numbers.",
      );
  }

  private load(): MemoryFile {
    try {
      if (existsSync(this.file))
        return fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // A damaged file starts over empty rather than breaking startup.
    }
    return { version: 1, facts: [], nicknames: [] };
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function memoryTools(memory: MemoryStore) {
  const refused = (err: unknown) => {
    if (err instanceof MemoryRefusedError) return { ok: false, speak: err.message };
    throw err;
  };
  return [
    defineTool({
      name: 'remember',
      description:
        'Remember a fact or preference the user tells you to keep ("remember that I take my coffee black"). Never for passwords, card numbers or other private details.',
      risk: 'safe',
      input: z.object({
        fact: z.string().min(1).max(200).describe("The fact, in the user's words"),
      }),
      describe: ({ fact }) => `Remember: ${fact}`,
      run: async ({ fact }) => {
        try {
          memory.remember(fact);
          return { ok: true, speak: "Got it, I'll remember that." };
        } catch (err) {
          return refused(err);
        }
      },
    }),
    defineTool({
      name: 'set_nickname',
      description:
        'Teach a nickname for an app, game, playlist, folder or person ("when I say my editor, I mean Visual Studio Code"). Used in every later command.',
      risk: 'safe',
      input: z.object({
        nickname: z.string().min(1).max(60),
        means: z.string().min(1).max(100),
      }),
      describe: ({ nickname, means }) => `Nickname "${nickname}" → ${means}`,
      run: async ({ nickname, means }) => {
        try {
          memory.setNickname(nickname, means);
          return { ok: true, speak: `Okay, "${nickname}" means ${means}.` };
        } catch (err) {
          return refused(err);
        }
      },
    }),
    defineTool({
      name: 'forget',
      description: 'Forget a remembered fact or nickname that matches the words given.',
      risk: 'safe',
      input: z.object({ what: z.string().min(1).max(200) }),
      describe: ({ what }) => `Forget ${what}`,
      run: async ({ what }) => {
        const removed = memory.forget(what);
        if (removed.length === 0)
          return {
            ok: false,
            speak: "I don't have anything like that remembered.",
            data: { remembered: memory.snapshot() },
            followUp: true,
          };
        return {
          ok: true,
          speak: removed.length === 1 ? 'Okay, forgotten.' : `Forgot ${removed.length} things.`,
        };
      },
    }),
    defineTool({
      name: 'list_memories',
      description: 'List what the user asked you to remember, and their nicknames.',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'List memories',
      run: async () => {
        const { facts, nicknames } = memory.snapshot();
        if (facts.length === 0 && nicknames.length === 0)
          return { ok: true, speak: "You haven't asked me to remember anything yet." };
        return {
          ok: true,
          speak: `I remember ${facts.length} thing${facts.length === 1 ? '' : 's'} and ${nicknames.length} nickname${nicknames.length === 1 ? '' : 's'}. They're listed in Settings, under Memory.`,
          data: {
            facts: facts.map((f) => f.text),
            nicknames: nicknames.map((n) => `${n.nickname} = ${n.means}`),
          },
          followUp: true,
        };
      },
    }),
  ];
}
