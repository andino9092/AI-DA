import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { buildProvider } from '../src/main/providers/llm/factory';
import type { ProviderId } from '../src/main/providers/llm/types';
import { grade } from './graders';
import { MeteredProvider, runTask } from './harness';
import { renderReport, type ModelResult, type TaskResult } from './report';
import { tasks as allTasks } from './tasks';
import type { EvalTask } from './types';

/*
 * npm run eval
 *
 * Environment (D-013, D-014):
 *   GEMINI_API_KEY, GROQ_API_KEY   keys; a model whose key is missing is skipped
 *   EVAL_MODELS                    "gemini:<model>,groq:<model>"; default below
 *   EVAL_RUNS                      runs per task and model; default 3
 *   EVAL_FILTER                    only tasks whose id contains this text
 *   EVAL_INTERVAL_MS               shortest gap between requests to one model; default 4000
 */

const DEFAULT_MODELS =
  'gemini:gemini-3.5-flash-lite,groq:qwen/qwen3.8-27b,groq:openai/gpt-oss-120b';
const KEY_NAMES: Record<ProviderId, string> = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY' };

const env = (name: string) => process.env[name]?.trim() || undefined;

function modelsUnderTest(notes: string[]): { label: string; provider: MeteredProvider }[] {
  const interval = Number(env('EVAL_INTERVAL_MS') ?? 4000);
  const out: { label: string; provider: MeteredProvider }[] = [];
  for (const spec of (env('EVAL_MODELS') ?? DEFAULT_MODELS).split(',')) {
    const [id, ...rest] = spec.trim().split(':');
    const model = rest.join(':');
    if ((id !== 'gemini' && id !== 'groq') || !model) {
      notes.push(`Skipped "${spec}": write it as gemini:<model> or groq:<model>.`);
      continue;
    }
    const key = env(KEY_NAMES[id]);
    if (!key) {
      notes.push(`Skipped ${spec}: ${KEY_NAMES[id]} is not set.`);
      continue;
    }
    out.push({
      label: spec.trim(),
      provider: new MeteredProvider(buildProvider(id, key, model), { minIntervalMs: interval }),
    });
  }
  return out;
}

/** Tasks the local parser should handle on every turn: no model involved, same result every time. */
const isLocal = (task: EvalTask) =>
  task.expect.routes?.length === task.say.length &&
  task.expect.routes.every((route) => route === 'instant');

async function runAll(
  tasks: EvalTask[],
  provider: MeteredProvider | null,
  runs: number,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const result: TaskResult = { task, runs: [] };
    for (let i = 0; i < runs; i++) {
      const { run, world } = await runTask(task, provider);
      result.runs.push({ run, grade: grade(task, run, world) });
    }
    results.push(result);
  }
  return results;
}

it('eval', async () => {
  const startedAt = new Date();
  const filter = env('EVAL_FILTER');
  const tasks = allTasks.filter((task) => !filter || task.id.includes(filter));
  const runs = Math.max(1, Number(env('EVAL_RUNS') ?? 3));
  const notes: string[] = [];
  const models = modelsUnderTest(notes);

  const local = tasks.filter(isLocal);
  const needModel = tasks.filter((task) => !isLocal(task));

  // Different models have separate rate limits, so they run side by side.
  const [localResults, ...modelResults] = await Promise.all([
    runAll(local, null, 1),
    ...models.map(({ provider }) => runAll(needModel, provider, runs)),
  ]);

  const results: ModelResult[] = [
    { model: 'local', results: localResults ?? [] },
    ...models.map(({ label }, i) => ({ model: label, results: modelResults[i] ?? [] })),
  ];
  if (models.length === 0)
    notes.push(
      `No API key set, so only the ${local.length} local tasks ran. Set GEMINI_API_KEY or GROQ_API_KEY to test ${needModel.length} more against a model.`,
    );
  const report = renderReport(results, startedAt, notes);

  const dir = join(__dirname, 'reports');
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(dir, `${stamp}.md`), report, 'utf8');
  writeFileSync(
    join(dir, `${stamp}.json`),
    JSON.stringify(
      results.map((m) => ({
        model: m.model,
        tasks: m.results.map((r) => ({
          id: r.task.id,
          category: r.task.category,
          // What was sent is left out: it repeats the whole prompt on every round trip.
          runs: r.runs.map(({ run, grade: g }) => ({ ...g, ...run, sent: undefined })),
        })),
      })),
      null,
      2,
    ),
    'utf8',
  );
  // scripts/print-eval-report.mjs prints the scorecard once Vitest has finished.
});
