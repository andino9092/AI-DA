import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/main/agent/assistant';
import { routineTools } from '../src/main/agent/routines';
import { MemoryStore, memoryTools } from '../src/main/memory/memory';
import { detectSensitive } from '../src/main/privacy/detectors';
import { PrivacyGuard } from '../src/main/privacy/guard';
import {
  ProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../src/main/providers/llm/types';
import { QuotaTracker } from '../src/main/router/quota';
import { LlmRouter } from '../src/main/router/router';
import { JsonlLog, type LogEntry, type OutboundEntry } from '../src/main/safety/action-log';
import { ToolExecutor } from '../src/main/safety/executor';
import { AppIndex } from '../src/main/tools/apps/app-index';
import { appTools } from '../src/main/tools/apps/tools';
import { timeTools } from '../src/main/tools/info/time';
import { TimerService, timerTools } from '../src/main/tools/info/timers';
import { unitTools } from '../src/main/tools/info/units';
import { mediaTools } from '../src/main/tools/media/tools';
import { ToolRegistry } from '../src/main/tools/registry';
import { audioTools } from '../src/main/tools/system/audio';
import type { AnyTool } from '../src/main/tools/types';
import { uiTools } from '../src/main/tools/ui/tools';
import { windowTools } from '../src/main/tools/windows/tools';
import type { Routine } from '../src/shared/settings';
import { FakeWindows } from '../tests/main/fakes';
import type { EvalTask, EvalWorld, Route, RunRecord } from './types';

/** An action log that also keeps its entries in memory, so the harness can read the route taken. */
class CapturingLog extends JsonlLog {
  readonly entries: (LogEntry | OutboundEntry)[] = [];

  override write(entry: LogEntry | OutboundEntry): void {
    this.entries.push(entry);
  }
}

export interface PacingOptions {
  /** Shortest gap between two requests to this provider (free tiers limit requests per minute). */
  minIntervalMs?: number;
  /** How often to wait and try again after "rate limited" or "overloaded". */
  retries?: number;
  /** The model takes one step per reply (D-029); the app sets this per provider. */
  stepwise?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wraps the model under test: paces requests to stay inside free-tier limits, waits out rate
 * limits, and measures every round trip. One instance is shared by all runs of one model, so the
 * pacing holds across tasks.
 */
export class MeteredProvider implements LlmProvider {
  private lastAt = 0;
  private recorder: RunRecord | null = null;

  constructor(
    private readonly inner: LlmProvider,
    private readonly options: PacingOptions = {},
  ) {}

  get id() {
    return this.inner.id;
  }

  get model() {
    return this.inner.model;
  }

  get stepwise() {
    return this.options.stepwise ?? false;
  }

  /** The run whose numbers the next requests count toward. */
  record(run: RunRecord | null): void {
    this.recorder = run;
  }

  async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const sleep = this.options.sleep ?? realSleep;
    const run = this.recorder;
    if (run) {
      const sent = JSON.stringify({
        system: request.system,
        messages: request.messages.map((m) =>
          m.role === 'assistant' ? { ...m, raw: undefined } : m,
        ),
        tools: request.tools,
      });
      run.llmCalls++;
      run.requestChars += sent.length;
      run.sent.push(sent);
      run.toolsOffered.push(request.tools.map((t) => t.name));
    }

    const retries = this.options.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastAt + (this.options.minIntervalMs ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
      const started = Date.now();
      try {
        const response = await this.inner.complete(request, signal);
        if (run) {
          run.llmMs += Date.now() - started;
          run.inputTokens += response.usage?.inputTokens ?? 0;
          run.outputTokens += response.usage?.outputTokens ?? 0;
        }
        return response;
      } catch (err) {
        const retryable =
          err instanceof ProviderError && (err.kind === 'rate_limit' || err.kind === 'unavailable');
        if (!retryable || attempt >= retries) throw err;
        // Free tiers say how long to wait; otherwise back off a little more each time.
        const pause =
          err.kind === 'rate_limit'
            ? Math.min(err.retryAfterMs ?? 20_000, 65_000)
            : 3_000 * (attempt + 1);
        await sleep(pause);
      }
    }
  }
}

/** A fresh simulated PC with AI-DA's real tools wired to it (D-012). */
function buildWorld(dir: string): { world: EvalWorld; tools: AnyTool[] } {
  const pc = new FakeWindows();
  const launched: string[] = [];
  const opened: string[] = [];
  const memory = new MemoryStore(
    join(dir, 'memory.json'),
    (text) => detectSensitive(text, { maskContactInfo: true, customValues: [] }).length > 0,
  );
  const timers = new TimerService(join(dir, 'timers.json'), () => {});
  const world: EvalWorld = { pc, launched, opened, memory, timers, routines: [] };
  const apps = new AppIndex(pc);

  const tools: AnyTool[] = [
    ...audioTools(pc),
    // No waiting for a real player to report the next track.
    ...mediaTools({ win: pc, appName: (id) => apps.nameForAppId(id), sleep: async () => {} }),
    ...appTools(pc, apps, {
      launchApp: (id) => void launched.push(id),
      openUrl: async (url) => void opened.push(url),
    }),
    ...windowTools(pc),
    ...uiTools({ win: pc, sensitiveApps: () => [] }),
    ...timeTools(),
    ...timerTools(timers),
    ...unitTools(),
    ...memoryTools(memory),
    ...routineTools({
      list: () => world.routines,
      save: (next: Routine[]) => void (world.routines = next),
    }),
  ];
  return { world, tools };
}

/**
 * Runs one task once: a fresh simulated PC, the real assistant, and the given model (or none, for
 * tasks the local parser handles). Returns what happened and the PC's end state for grading.
 */
export async function runTask(
  task: EvalTask,
  provider: MeteredProvider | null,
): Promise<{ run: RunRecord; world: EvalWorld }> {
  const dir = mkdtempSync(join(tmpdir(), 'aida-eval-'));
  const { world, tools } = buildWorld(dir);
  const run: RunRecord = {
    turns: [],
    toolCalls: [],
    confirms: [],
    llmCalls: 0,
    requestChars: 0,
    inputTokens: 0,
    outputTokens: 0,
    llmMs: 0,
    toolsOffered: [],
    sent: [],
    stepwise: provider?.stepwise ?? false,
  };

  try {
    task.setup?.(world);

    // Record every tool run with the arguments it actually received.
    const registry = new ToolRegistry().register(
      ...tools.map((tool): AnyTool => ({
        ...tool,
        run: async (args: unknown, ctx) => {
          const result = await tool.run(args, ctx);
          run.toolCalls.push({
            name: tool.name,
            args,
            ok: result.ok,
            followUp: result.followUp === true,
          });
          return result;
        },
      })),
    );

    const guard = new PrivacyGuard(() => ({ maskContactInfo: false, customValues: [] }));
    const log = new CapturingLog(join(dir, 'logs'), 'actions');
    const outbound = new CapturingLog(join(dir, 'logs'), 'outbound');
    const executor = new ToolExecutor(
      registry,
      guard,
      async (request) => {
        const approved = task.approve ?? true;
        run.confirms.push({ summary: request.summary, approved });
        return approved;
      },
      log,
    );
    const router = new LlmRouter(
      () =>
        provider
          ? [{ provider, dailyLimit: Number.MAX_SAFE_INTEGER, stepwise: provider.stepwise }]
          : [],
      new QuotaTracker(join(dir, 'quota.json')),
      outbound,
      undefined,
      // Pauses for rate limits happen inside the provider; don't let the router give up on them.
      { attemptTimeoutMs: 10 * 60_000 },
    );
    const assistant = new Assistant({
      guard,
      registry,
      executor,
      router,
      log,
      emit: () => {},
      routines: () => world.routines,
      memory: world.memory,
    });

    provider?.record(run);
    for (const said of task.say) {
      const before = log.entries.length;
      const reply = await assistant.handle(said, {
        source: 'palette',
        activeWindow: world.pc.foreground,
      });
      const entries = log.entries.slice(before);
      const routed = entries.find(
        (entry): entry is Extract<LogEntry, { type: 'route' }> => entry.type === 'route',
      );
      run.turns.push({ said, reply, route: (routed?.route as Route | undefined) ?? null });
      // The model couldn't be reached: the run says nothing about the model, so don't grade it.
      const broke = entries.find(
        (entry): entry is Extract<LogEntry, { type: 'error' }> => entry.type === 'error',
      );
      if (broke) {
        // A request the provider refused because the model wrote a bad tool call is the model's
        // failure, and the user would hear an error: grade it. Anything else (key, network,
        // overload) says nothing about the model.
        if (/couldn't handle that request/.test(broke.text)) run.rejected = broke.text;
        else run.error = broke.text;
        break;
      }
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
  } finally {
    provider?.record(null);
    world.timers.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
  return { run, world };
}
