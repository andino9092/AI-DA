import { z } from 'zod';
import type { Routine } from '@shared/settings';
import { defineTool } from '../tools/types';
import { normalizeName } from '../util/fuzzy';

/** "Gaming mode" and "gaming" are the same routine; so are "good morning routine" and "good morning". */
function key(name: string): string {
  return normalizeName(name)
    .replace(/\b(?:mode|routine)$/, '')
    .trim();
}

/**
 * "gaming mode", "start gaming mode", "run my good morning routine", "hey aida, good morning" →
 * the routine, or null. Only whole-command matches count, so "open steam" never triggers a
 * routine unless one is literally called that.
 */
export function matchRoutine(text: string, routines: readonly Routine[]): Routine | null {
  if (routines.length === 0) return null;
  const said = normalizeName(text)
    .replace(/^(?:hey |ok |okay )?(?:aida|ada) /, '')
    .replace(/^(?:please |can you |could you )+/, '')
    .replace(/ please$/, '')
    .replace(
      /^(?:start|run|do|activate|begin|turn on|enable|switch to|go into|go to|use|it s|its|time for) /,
      '',
    )
    .replace(/^(?:the |my )/, '');
  const wanted = key(said);
  if (!wanted) return null;
  return routines.find((r) => key(r.name) === wanted) ?? null;
}

export interface RoutineStore {
  list(): Routine[];
  save(routines: Routine[]): void;
}

const MAX_ROUTINES = 20;

export function routineTools(store: RoutineStore) {
  return [
    defineTool({
      name: 'create_routine',
      description:
        'Create or replace a routine: a name the user can say ("gaming mode") that runs several commands in order, each written as the user would say it ("open steam", "set volume to 40").',
      risk: 'safe',
      input: z.object({
        name: z.string().min(1).max(40),
        steps: z.array(z.string().min(1).max(200)).min(1).max(10),
      }),
      describe: ({ name, steps }) => `Create routine "${name}": ${steps.join('; ')}`,
      run: async ({ name, steps }) => {
        const others = store.list().filter((r) => key(r.name) !== key(name));
        if (others.length >= MAX_ROUTINES)
          return { ok: false, speak: `You can have up to ${MAX_ROUTINES} routines.` };
        store.save([...others, { name: name.trim(), steps: steps.map((s) => s.trim()) }]);
        return {
          ok: true,
          speak: `Saved ${name}. Say "${name}" to run its ${steps.length} step${steps.length === 1 ? '' : 's'}.`,
        };
      },
    }),
    defineTool({
      name: 'delete_routine',
      description: 'Delete a routine by name.',
      risk: 'safe',
      input: z.object({ name: z.string().min(1).max(40) }),
      describe: ({ name }) => `Delete routine "${name}"`,
      run: async ({ name }) => {
        const all = store.list();
        const kept = all.filter((r) => key(r.name) !== key(name));
        if (kept.length === all.length)
          return {
            ok: false,
            speak: `There's no routine called ${name}.`,
            data: { routines: all.map((r) => r.name) },
            followUp: true,
          };
        store.save(kept);
        return { ok: true, speak: `Deleted ${name}.` };
      },
    }),
  ];
}
