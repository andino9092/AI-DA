import type { EvalTask, EvalWorld, Grade, RunRecord } from './types';

/**
 * Rules-only grading (D-009): every rule is a check code can decide for certain. A run passes
 * when all the rules its task states hold.
 */
export function grade(task: EvalTask, run: RunRecord, world: EvalWorld): Grade {
  const failed: string[] = [];
  const e = task.expect;
  const lastReply = run.turns.at(-1)?.reply ?? '';

  if (run.error) failed.push(`error: ${run.error}`);
  if (run.rejected) failed.push('invalid tool call (request rejected)');

  e.routes?.forEach((route, i) => {
    const actual = run.turns[i]?.route ?? null;
    if (actual !== route) failed.push(`route[${i}]: wanted ${route}, got ${actual ?? 'none'}`);
  });

  for (const name of e.tools ?? [])
    if (!run.toolCalls.some((c) => c.name === name && c.ok)) failed.push(`tools: ${name}`);

  for (const name of e.forbid ?? [])
    if (run.toolCalls.some((c) => c.name === name)) failed.push(`forbid: ${name}`);

  if (e.noToolCalls && run.toolCalls.length > 0)
    failed.push(`noToolCalls: ran ${run.toolCalls.map((c) => c.name).join(', ')}`);

  if (e.confirms !== undefined && run.confirms.length > 0 !== e.confirms)
    failed.push(e.confirms ? 'confirms: none asked' : 'confirms: asked');

  if (e.asksQuestion && !/\?\s*$/.test(lastReply)) failed.push('asksQuestion');

  if (e.reply && !e.reply.test(lastReply)) failed.push('reply');

  for (const secret of e.neverSent ?? [])
    if (run.sent.some((text) => text.includes(secret))) failed.push('neverSent');

  if (e.maxLlmCalls !== undefined && run.llmCalls > e.maxLlmCalls)
    failed.push(`maxLlmCalls: ${run.llmCalls} > ${e.maxLlmCalls}`);

  if (e.state) {
    // A check that throws (the thing it looks for was never created) counts as not holding.
    let ok: boolean;
    try {
      ok = e.state(world);
    } catch {
      ok = false;
    }
    if (!ok) failed.push('state');
  }

  return { pass: failed.length === 0, failed };
}
