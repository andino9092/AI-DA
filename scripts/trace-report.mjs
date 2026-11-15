// npm run trace:report [-- --days 7] [--dir <logs folder>]
//
// Summarises the traces log (traces-YYYY-MM-DD.jsonl): where the time goes, how many requests
// reach the AI, what they cost, and what fails. The log holds numbers and names only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Typical value: half the requests are faster. */
const median = (values) => percentile(values, 0.5);

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

/** Time the request spent waiting for the user to answer a confirmation. */
const waited = (trace) => sum(trace.spans.filter((s) => s.name === 'confirm').map((s) => s.ms));

/**
 * @param {object[]} traces entries of the traces log
 * @returns the numbers the report prints
 */
export function summarize(traces) {
  const stage = (name) => traces.flatMap((t) => t.spans.filter((s) => s.name === name));
  const llm = stage('llm');
  const answered = llm.filter((s) => !s.error);
  const viaModel = traces.filter((t) => t.route === 'llm');

  const stages = {};
  for (const name of ['stt', 'llm', 'tool', 'tts']) {
    const spans = name === 'llm' ? answered : stage(name);
    // A tool's time includes any confirmation wait inside it; that wait is the user's, not ours.
    const ms = spans.map((s) => s.ms);
    stages[name] = { count: ms.length, median: median(ms), p95: percentile(ms, 0.95) };
  }

  const routes = {};
  for (const t of traces) {
    const key = t.route ?? 'none';
    const total = t.totalMs - waited(t);
    (routes[key] ??= { count: 0, totals: [] }).count++;
    routes[key].totals.push(total);
  }
  for (const r of Object.values(routes)) {
    r.median = median(r.totals);
    r.p95 = percentile(r.totals, 0.95);
    delete r.totals;
  }

  const models = {};
  for (const s of llm) {
    const m = (models[`${s.provider}:${s.model}`] ??= {
      requests: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    m.requests++;
    if (s.error) m.failed++;
    m.inputTokens += s.inputTokens ?? 0;
    m.outputTokens += s.outputTokens ?? 0;
  }

  const failures = {};
  for (const s of llm.filter((x) => x.error)) {
    const key = `${s.provider}: ${s.error}`;
    failures[key] = (failures[key] ?? 0) + 1;
  }
  const toolFailures = {};
  for (const s of stage('tool').filter((x) => !x.ok))
    toolFailures[s.tool] = (toolFailures[s.tool] ?? 0) + 1;

  const perDay = {};
  for (const t of traces) {
    const day = String(t.ts ?? '').slice(0, 10) || 'unknown';
    const d = (perDay[day] ??= { requests: 0, llmRequests: 0, tokens: 0 });
    d.requests++;
    for (const s of t.spans.filter((x) => x.name === 'llm')) {
      d.llmRequests++;
      d.tokens += (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
    }
  }

  return {
    requests: traces.length,
    failed: traces.filter((t) => !t.ok).length,
    voice: traces.filter((t) => t.source === 'voice').length,
    routes,
    stages,
    // Model round trips per request that reached the AI, counting failed attempts.
    llmCallsPerRequest: viaModel.length
      ? sum(viaModel.map((t) => t.spans.filter((s) => s.name === 'llm').length)) / viaModel.length
      : 0,
    inputTokensPerCall: answered.length
      ? sum(answered.map((s) => s.inputTokens ?? 0)) / answered.length
      : 0,
    toolsOfferedPerCall: llm.length ? sum(llm.map((s) => s.toolsOffered ?? 0)) / llm.length : 0,
    models,
    failures,
    toolFailures,
    perDay,
  };
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const share = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '–');

/** @returns {string} the report as plain text */
export function render(summary, days) {
  const s = summary;
  if (s.requests === 0)
    return `No requests traced in the last ${days} day(s). Use AI-DA for a while, then run this again.`;
  const lines = [];
  const table = (rows) => {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    for (const row of rows)
      lines.push(`  ${row.map((cell, i) => String(cell).padEnd(widths[i])).join('   ')}`.trimEnd());
  };

  lines.push(`AI-DA trace report: last ${days} day(s)`, '');
  lines.push(
    `${s.requests} requests (${s.voice} spoken, ${s.requests - s.voice} typed); ${s.failed} failed.`,
    '',
  );

  lines.push('How requests were handled (time excludes waiting for your confirmations)');
  table([
    ['Route', 'Requests', 'Share', 'Typical', 'Slowest 5%'],
    ...Object.entries(s.routes).map(([route, r]) => [
      route === 'instant' ? 'instant (no AI)' : route === 'llm' ? 'AI model' : route,
      r.count,
      share(r.count, s.requests),
      seconds(r.median),
      seconds(r.p95),
    ]),
  ]);

  lines.push('', 'Time per stage');
  const labels = {
    stt: 'Speech to text',
    llm: 'AI model call',
    tool: 'Tool run',
    tts: 'Reply to first audio',
  };
  table([
    ['Stage', 'Count', 'Typical', 'Slowest 5%'],
    ...Object.entries(s.stages)
      .filter(([, v]) => v.count > 0)
      .map(([name, v]) => [labels[name], v.count, seconds(v.median), seconds(v.p95)]),
  ]);

  if (Object.keys(s.models).length > 0) {
    lines.push('', 'AI usage');
    lines.push(
      `  ${s.llmCallsPerRequest.toFixed(1)} model calls per AI request; ${Math.round(
        s.inputTokensPerCall,
      )} input tokens and ${s.toolsOfferedPerCall.toFixed(0)} tools offered per call.`,
    );
    table([
      ['Model', 'Calls', 'Failed', 'Input tokens', 'Output tokens'],
      ...Object.entries(s.models).map(([model, m]) => [
        model,
        m.requests,
        m.failed,
        m.inputTokens,
        m.outputTokens,
      ]),
    ]);
    lines.push('', 'Per day (free tiers reset daily)');
    table([
      ['Day', 'Requests', 'AI calls', 'Tokens'],
      ...Object.entries(s.perDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, d]) => [day, d.requests, d.llmRequests, d.tokens]),
    ]);
  }

  const failures = [
    ...Object.entries(s.failures).map(([k, n]) => [`AI ${k}`, n]),
    ...Object.entries(s.toolFailures).map(([k, n]) => [`tool ${k}`, n]),
  ].sort((a, b) => b[1] - a[1]);
  if (failures.length > 0) {
    lines.push('', 'What failed');
    table([['What', 'Times'], ...failures]);
  }
  return lines.join('\n');
}

/**
 * Voice diagnostics (voice-YYYY-MM-DD.jsonl, written only while the Settings switch is on): what
 * became of everything the microphone picked up.
 */
export function summarizeVoice(heard) {
  const outcomes = {};
  for (const h of heard) outcomes[h.outcome] = (outcomes[h.outcome] ?? 0) + 1;

  // Every time the wake phrase was recognised and the voice was checked.
  const checked = heard.filter((h) => h.wakeMatched && h.voiceScore !== undefined);
  const scores = checked.map((h) => h.voiceScore);
  const rejected = checked.filter((h) => h.outcome === 'rejected: voice');
  const threshold = checked.at(-1)?.threshold ?? null;

  const commands = heard.filter((h) => h.mode === 'command');
  const stt = heard.filter((h) => h.sttMs !== undefined).map((h) => h.sttMs);
  return {
    heard: heard.length,
    outcomes,
    voice: {
      checked: checked.length,
      rejected: rejected.length,
      // Rejections a slightly lower threshold would have let through.
      nearMisses: rejected.filter((h) => h.voiceScore >= (h.threshold ?? 0) - 0.1).length,
      lowest: scores.length ? Math.min(...scores) : 0,
      median: median(scores),
      highest: scores.length ? Math.max(...scores) : 0,
      threshold,
    },
    commands: {
      listened: commands.length,
      accepted: commands.filter((h) => h.outcome === 'accepted').length,
      timeouts: commands.filter((h) => h.outcome === 'timeout').length,
      empty: commands.filter((h) => h.outcome === 'empty').length,
      // An accepted command of one or two words may have lost its beginning.
      veryShort: commands.filter((h) => h.outcome === 'accepted' && (h.words ?? 0) <= 2).length,
    },
    sttMedian: median(stt),
    sttP95: percentile(stt, 0.95),
  };
}

const OUTCOME_LABELS = {
  accepted: 'Command understood and run',
  'wake only': '"Hey Aida" alone: started listening',
  'wake, more to come': '"Hey Aida" over continuous sound',
  'rejected: voice': '"Hey Aida" heard, voice did not match',
  'not addressed': 'Speech without "Hey Aida" (ignored)',
  'wake not acted on': '"Hey Aida" while wake was off or paused',
  busy: '"Hey Aida" while a command was running',
  empty: 'Listening, but nothing usable heard',
  'repeated wake': '"Hey Aida" again while listening',
  stop: '"Stop" / "never mind"',
  'stt error': 'Transcription failed',
  timeout: 'Listened for a command; none came',
};

/** @returns {string} the voice part of the report */
export function renderVoice(summary, days) {
  const s = summary;
  if (s.heard === 0)
    return `No voice diagnostics in the last ${days} day(s). Turn on Settings → Voice → "Record voice diagnostics", use AI-DA, then run this again.`;
  const lines = [`Voice diagnostics: ${s.heard} things heard`, ''];
  const table = (rows) => {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    for (const row of rows)
      lines.push(`  ${row.map((cell, i) => String(cell).padEnd(widths[i])).join('   ')}`.trimEnd());
  };
  table([
    ['What happened', 'Times', 'Share'],
    ...Object.entries(s.outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, n]) => [OUTCOME_LABELS[outcome] ?? outcome, n, share(n, s.heard)]),
  ]);

  if (s.voice.checked > 0) {
    lines.push('', 'Voice match on "Hey Aida"');
    lines.push(
      `  Checked ${s.voice.checked} times; ${s.voice.rejected} rejected (${s.voice.nearMisses} within 0.10 of the threshold).`,
      `  Scores: lowest ${s.voice.lowest.toFixed(2)}, typical ${s.voice.median.toFixed(2)}, highest ${s.voice.highest.toFixed(2)}; needed ${s.voice.threshold?.toFixed(2) ?? '?'}.`,
    );
  }
  if (s.commands.listened > 0) {
    lines.push('', 'After Aida started listening for a command');
    lines.push(
      `  ${s.commands.listened} times: ${s.commands.accepted} understood, ${s.commands.timeouts} heard nothing in time, ${s.commands.empty} heard nothing usable.`,
      `  ${s.commands.veryShort} understood commands were only one or two words (their start may have been lost).`,
    );
  }
  lines.push(
    '',
    `Speech to text: typical ${seconds(s.sttMedian)}, slowest 5% ${seconds(s.sttP95)}.`,
  );
  return lines.join('\n');
}

/** Reads one kind of log (traces, voice) for the last `days` days from a logs folder. */
function readLog(dir, prefix, days, now, keep) {
  if (!existsSync(dir)) return [];
  const cutoff = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const match = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})(?:-2)?\\.jsonl$`).exec(name);
    if (!match || match[1] < cutoff) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (keep(entry)) entries.push(entry);
      } catch {
        // A half-written last line: skip it.
      }
    }
  }
  return entries;
}

/** Reads the trace lines of the last `days` days from a logs folder. */
export function readTraces(dir, days, now = new Date()) {
  return readLog(dir, 'traces', days, now, (e) => e.type === 'trace' && Array.isArray(e.spans));
}

/** Reads the voice diagnostics lines of the last `days` days from a logs folder. */
export function readVoice(dir, days, now = new Date()) {
  return readLog(
    dir,
    'voice',
    days,
    now,
    (e) => e.type === 'heard' && typeof e.outcome === 'string',
  );
}

/**
 * What Aida heard and what she did with it, newest last, from the action log (which already
 * holds each accepted command with sensitive values masked). Speech that was ignored is not in
 * any log as text.
 */
export function recentCommands(actions, limit = 20) {
  const byRequest = new Map();
  for (const a of actions) {
    if (!a.requestId) continue;
    const c =
      byRequest.get(a.requestId) ??
      byRequest
        .set(a.requestId, { at: a.ts, heard: '', routes: [], tools: [], reply: '', declined: 0 })
        .get(a.requestId);
    if (a.type === 'command') {
      c.heard = a.text;
      c.at = a.ts;
    } else if (a.type === 'route') c.routes.push(a.route);
    else if (a.type === 'tool') c.tools.push({ tool: a.tool, ok: a.ok, summary: a.summary });
    else if (a.type === 'confirm' && !a.approved) c.declined++;
    else if (a.type === 'reply') c.reply = a.text;
    else if (a.type === 'error') c.reply = a.text;
  }
  return [...byRequest.values()].filter((c) => c.heard).slice(-limit);
}

/** @returns {string} the "what was heard" part of the report */
export function renderCommands(commands) {
  if (commands.length === 0) return 'No commands in the action log for these days.';
  const lines = [`What Aida heard and did (last ${commands.length} commands, oldest first)`];
  for (const c of commands) {
    const time = String(c.at ?? '').slice(11, 19);
    // The parser's attempt failed and the AI took over: both show up.
    const local = c.tools.length > 0 && c.routes[0] === 'llm' && c.tools[0].ok === false;
    const route = c.routes.includes('routine')
      ? 'routine'
      : c.routes.includes('llm')
        ? local
          ? 'instant failed, then AI'
          : 'AI'
        : 'instant';
    lines.push('', `  ${time}  heard: "${c.heard}"`);
    lines.push(`            handled by: ${route}`);
    for (const t of c.tools)
      lines.push(`            ${t.ok ? 'did' : 'FAILED'}: ${t.summary} (${t.tool})`);
    if (c.declined) lines.push(`            you declined ${c.declined} confirmation(s)`);
    lines.push(`            said: "${c.reply}"`);
  }
  return lines.join('\n');
}

/** Reads the action log lines of the last `days` days from a logs folder. */
export function readActions(dir, days, now = new Date()) {
  return readLog(dir, 'actions', days, now, (e) => typeof e.type === 'string');
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const days = Math.max(1, Number(option('--days') ?? 7));
  // Where the app keeps its logs (Electron's userData folder for "AI-DA").
  const dir = option('--dir') ?? join(process.env.APPDATA ?? '', 'AI-DA', 'logs');
  console.log(render(summarize(readTraces(dir, days)), days));
  console.log(`\n${renderVoice(summarizeVoice(readVoice(dir, days)), days)}`);
  // --heard [n]: also list the last n commands as transcribed, with what was done about them.
  if (args.includes('--heard')) {
    const count = Number(option('--heard'));
    const commands = recentCommands(readActions(dir, days), count > 0 ? count : 20);
    console.log(`\n${renderCommands(commands)}`);
  }
  console.log(`\nRead from ${dir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
