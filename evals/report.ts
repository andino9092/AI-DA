import type { Category, EvalTask, Grade, RunRecord } from './types';

export interface TaskResult {
  task: EvalTask;
  runs: { run: RunRecord; grade: Grade }[];
}

export interface ModelResult {
  /** "local" for commands the parser handles without a model. */
  model: string;
  results: TaskResult[];
}

const pct = (n: number, of: number) => (of === 0 ? '–' : `${Math.round((n / of) * 100)}%`);
const avg = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Runs that broke before the model could answer are left out of pass rates. */
const graded = (result: TaskResult) => result.runs.filter((r) => !r.run.error);

function askedForMoreTools(run: RunRecord): boolean {
  // A later request carries the earlier assistant turn; look for a more_tools call in it.
  return run.sent.some((text) =>
    /"role":"assistant"[^[]*"toolCalls":\[[^\]]*"more_tools"/.test(text),
  );
}

export function summarize(model: ModelResult) {
  const runs = model.results.flatMap(graded);
  const withModel = runs.filter((r) => r.run.llmCalls > 0);
  const categories = new Map<Category, { pass: number; total: number }>();
  for (const result of model.results) {
    const entry = categories.get(result.task.category) ?? { pass: 0, total: 0 };
    for (const r of graded(result)) {
      entry.total++;
      if (r.grade.pass) entry.pass++;
    }
    categories.set(result.task.category, entry);
  }
  return {
    model: model.model,
    pass: runs.filter((r) => r.grade.pass).length,
    total: runs.length,
    broken: model.results.flatMap((r) => r.runs).length - runs.length,
    categories,
    llmCalls: avg(withModel.map((r) => r.run.llmCalls)),
    requestChars: avg(withModel.map((r) => r.run.requestChars)),
    secondsPerCall: avg(withModel.map((r) => r.run.llmMs / r.run.llmCalls)) / 1000,
    toolsOffered: avg(withModel.map((r) => r.run.toolsOffered[0]?.length ?? 0)),
    moreTools: withModel.filter((r) => askedForMoreTools(r.run)).length,
    withModel: withModel.length,
  };
}

/** The scorecard as Markdown: one summary table, then every task per model. */
export function renderReport(models: ModelResult[], startedAt: Date, notes: string[] = []): string {
  const lines: string[] = [
    `# AI-DA eval scorecard`,
    '',
    `Run started ${startedAt.toISOString()}.`,
    '',
  ];
  if (notes.length > 0) lines.push(...notes.map((note) => `- ${note}`), '');
  const summaries = models.map(summarize);

  lines.push('## Summary', '');
  lines.push(
    '| Model | Pass rate | Model calls per task | Request size (chars) | Seconds per call | Tools offered | Asked for more tools | Broken runs |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const s of summaries) {
    const local = s.withModel === 0;
    lines.push(
      `| ${s.model} | ${pct(s.pass, s.total)} (${s.pass}/${s.total}) | ${
        local ? '–' : s.llmCalls.toFixed(1)
      } | ${local ? '–' : Math.round(s.requestChars)} | ${local ? '–' : s.secondsPerCall.toFixed(1)} | ${
        local ? '–' : s.toolsOffered.toFixed(0)
      } | ${local ? '–' : `${s.moreTools}/${s.withModel}`} | ${s.broken} |`,
    );
  }

  lines.push('', '## Pass rate by category', '');
  const allCategories = [...new Set(summaries.flatMap((s) => [...s.categories.keys()]))];
  lines.push(`| Category | ${summaries.map((s) => s.model).join(' | ')} |`);
  lines.push(`|---|${summaries.map(() => '---').join('|')}|`);
  for (const category of allCategories) {
    const cells = summaries.map((s) => {
      const c = s.categories.get(category);
      return c && c.total > 0 ? `${pct(c.pass, c.total)} (${c.pass}/${c.total})` : '–';
    });
    lines.push(`| ${category} | ${cells.join(' | ')} |`);
  }

  for (const model of models) {
    lines.push('', `## ${model.model}`, '');
    lines.push('| Task | Category | Passed | Model calls | What failed |', '|---|---|---|---|---|');
    for (const result of model.results) {
      const runs = graded(result);
      const passes = runs.filter((r) => r.grade.pass).length;
      const failures = new Map<string, number>();
      for (const r of result.runs)
        for (const rule of r.grade.failed) failures.set(rule, (failures.get(rule) ?? 0) + 1);
      const failed = [...failures.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([rule, count]) => `${rule} ×${count}`)
        .join('; ')
        .replace(/\|/g, '\\|');
      const calls = avg(runs.map((r) => r.run.llmCalls));
      lines.push(
        `| ${result.task.id} | ${result.task.category} | ${passes}/${runs.length} | ${calls.toFixed(1)} | ${failed} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
