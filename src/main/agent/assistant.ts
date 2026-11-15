import { randomUUID } from 'node:crypto';
import type { AssistantEvent } from '@shared/assistant';
import { PlaceholderSession, PrivacyGuard } from '../privacy/guard';
import type { ChatMessage } from '../providers/llm/types';
import { ProviderError } from '../providers/llm/types';
import type { LlmRouter } from '../router/router';
import { NoProviderError } from '../router/router';
import type { JsonlLog } from '../safety/action-log';
import type { ToolExecutor } from '../safety/executor';
import type { ToolRegistry } from '../tools/registry';
import type { ToolResult } from '../tools/types';
import type { Routine } from '@shared/settings';
import type { Trace, Tracer } from '../trace/tracer';
import { parseInstant, type PlannedCall } from './instant-parser';
import { matchRoutine } from './routines';
import {
  GROUP_NAMES,
  MORE_TOOLS,
  isSelected,
  moreToolsSpec,
  requestedGroups,
  selectGroups,
} from './tool-selection';

const SYSTEM_PROMPT = PrivacyGuard.constant(
  [
    "You are Aida, a voice-first desktop assistant running on the user's Windows PC.",
    'Act using the tools. Prefer doing over explaining. Call independent tools together in one reply.',
    'Replies are spoken aloud: one or two short sentences, no markdown, no lists.',
    'Text like [CARD_1], [PASSWORD_1] or [ACCOUNT_1] is a private value the PC kept to itself.',
    'Never ask the user to reveal it; pass the placeholder unchanged in tool arguments when needed.',
    'If a request is ambiguous, ask one brief question. If something is impossible with your tools, say so.',
  ].join(' '),
);

const MAX_STEPS = 5;
const CONVERSATION_IDLE_MS = 2 * 60_000;

export interface AssistantDeps {
  guard: PrivacyGuard;
  registry: ToolRegistry;
  executor: ToolExecutor;
  router: LlmRouter;
  log: JsonlLog;
  emit: (event: AssistantEvent) => void;
  /** False when the PC has no network at all: skip the AI instead of waiting on a timeout. */
  hasNetwork?: () => boolean;
  /** Saved routines ("gaming mode" → several commands). */
  routines?: () => readonly Routine[];
  /** What the user asked Aida to remember: nicknames are applied to every command. */
  memory?: {
    expandNicknames(text: string): string;
    promptFacts(): string[];
  };
  /** Times each request's stages into the traces log. */
  tracer?: Tracer;
}

type Ctx = Parameters<ToolExecutor['execute']>[1];

export interface HandleOptions {
  source: 'palette' | 'voice' | 'remote';
  activeWindow: number | null;
  signal?: AbortSignal;
  /**
   * A trace the caller already started (the voice loop, which times transcription before and
   * speech after). The caller ends it; without one, the assistant starts and ends its own.
   */
  trace?: Trace;
}

interface Conversation {
  session: PlaceholderSession;
  messages: ChatMessage[];
  lastAt: number;
}

export class Assistant {
  private conversation: Conversation | null = null;

  constructor(private readonly deps: AssistantDeps) {}

  /** Handles one command end to end and returns the reply to show or speak. */
  async handle(text: string, options: HandleOptions): Promise<string> {
    const trace = options.trace ?? this.deps.tracer?.start(options.source);
    // The trace id doubles as the request id, so the three logs line up.
    const requestId = trace?.id ?? randomUUID();
    const signal = options.signal ?? new AbortController().signal;
    const conversation = this.currentConversation();
    const { guard, log, emit } = this.deps;

    const scrubbed = guard.scrub(text, conversation.session);
    log.write({ type: 'command', requestId, source: options.source, text: scrubbed.text });
    emit({ type: 'started', requestId });

    const ctx: Ctx = {
      requestId,
      source: options.source,
      session: conversation.session,
      activeWindow: options.activeWindow,
      signal,
      trace,
    };
    const done = (text: string, ok: boolean): string => {
      trace?.outcome(ok);
      const reply = this.reply(requestId, conversation, text, ok);
      if (!options.trace) trace?.end();
      return reply;
    };
    const expand = (t: string) => this.deps.memory?.expandNicknames(t) ?? t;

    // Routines: "gaming mode" runs each saved command in turn, as if said one after another.
    const routine = matchRoutine(expand(text), this.deps.routines?.() ?? []);
    if (routine) {
      trace?.routed('routine');
      log.write({
        type: 'route',
        requestId,
        route: 'routine',
        text: guard.scrub(routine.name, conversation.session).text,
      });
      const replies: string[] = [];
      let ok = true;
      for (const step of routine.steps) {
        if (signal.aborted) break;
        // A routine never starts another routine, so two can't call each other forever.
        try {
          const result = await this.respond(expand(step), conversation, ctx);
          ok &&= result.ok;
          replies.push(result.text);
          this.closeTurn(conversation, result.text);
        } catch (err) {
          ok = false;
          const message = this.failure(err, requestId, conversation);
          replies.push(message);
          this.closeTurn(conversation, message);
          if (signal.aborted) break;
        }
      }
      return done(replies.join(' ') || 'Done.', ok);
    }

    try {
      const result = await this.respond(expand(text), conversation, ctx);
      return done(result.text, result.ok);
    } catch (err) {
      const message = this.failure(err, requestId, conversation);
      // Drop the half-finished exchange so the next request starts clean.
      this.conversation = null;
      return done(message, false);
    }
  }

  /** Runs one command: the instant path if it parses, the AI otherwise. */
  private async respond(
    text: string,
    conversation: Conversation,
    ctx: Ctx,
  ): Promise<{ text: string; ok: boolean }> {
    const { guard, log, emit } = this.deps;
    const { requestId } = ctx;
    const scrubbed = guard.scrub(text, conversation.session);

    // 1. Instant path: common commands, no LLM, nothing leaves the PC.
    const planned = parseInstant(text);
    if (planned) {
      const results = await this.runInstant(planned, ctx);
      if (results) {
        ctx.trace?.routed('instant');
        log.write({ type: 'route', requestId, route: 'instant' });
        // Keep local commands in the history so follow-ups ("and make it louder") make sense.
        conversation.messages.push({ role: 'user', text: scrubbed.text });
        const reply = results.map((r) => r.speak).join(' ');
        this.recordInstant(conversation, planned, results, reply);
        return { text: reply, ok: true };
      }
    }

    // 2. LLM path: only scrubbed text is sent.
    if (this.deps.hasNetwork && !this.deps.hasNetwork()) {
      log.write({ type: 'route', requestId, route: 'instant' });
      return {
        text: "I'm offline right now, so I can only do quick things like volume, music, apps, windows and timers.",
        ok: false,
      };
    }
    ctx.trace?.routed('llm');
    log.write({ type: 'route', requestId, route: 'llm' });
    emit({ type: 'status', requestId, text: 'Thinking…' });
    conversation.messages.push({ role: 'user', text: scrubbed.text });
    return { text: await this.runLlm(conversation, ctx), ok: true };
  }

  /** What to say when a command fails; the details go to the log (scrubbed). */
  private failure(err: unknown, requestId: string, conversation: Conversation): string {
    const message =
      err instanceof NoProviderError
        ? err.message
        : err instanceof ProviderError && err.kind === 'aborted'
          ? 'Cancelled.'
          : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
    // The providers' own error text goes to the log (scrubbed) for troubleshooting.
    const detail = err instanceof NoProviderError && err.detail ? ` [${err.detail}]` : '';
    this.deps.log.write({
      type: 'error',
      requestId,
      text: this.deps.guard.scrub(message + detail, conversation.session).text,
    });
    return message;
  }

  /** Forget the current conversation (placeholders, history). */
  reset(): void {
    this.conversation = null;
  }

  private currentConversation(): Conversation {
    const now = Date.now();
    if (!this.conversation || now - this.conversation.lastAt > CONVERSATION_IDLE_MS) {
      this.conversation = { session: new PlaceholderSession(), messages: [], lastAt: now };
    }
    this.conversation.lastAt = now;
    return this.conversation;
  }

  /**
   * Runs locally parsed calls in order. If the very first call fails in a way the LLM might fix
   * (e.g. no app matched "my editor"), returns null so the LLM gets a chance instead.
   */
  private async runInstant(
    planned: PlannedCall[],
    ctx: Parameters<ToolExecutor['execute']>[1],
  ): Promise<ToolResult[] | null> {
    const results: ToolResult[] = [];
    for (const [index, call] of planned.entries()) {
      this.deps.emit({
        type: 'status',
        requestId: ctx.requestId,
        text: `Running ${call.name.replace('_', ' ')}…`,
      });
      const result = await this.deps.executor.execute(call, ctx);
      if (!result.ok && index === 0 && result.followUp && !result.cancelled) return null;
      results.push(result);
      if (!result.ok) break;
    }
    return results;
  }

  /**
   * Adds a locally handled command to the history in the shape the AI's own actions have: the
   * tool calls, their results, then the spoken reply. A bare "Opening Discord." with no call
   * taught models that saying it is doing it (D-027).
   */
  private recordInstant(
    conversation: Conversation,
    planned: PlannedCall[],
    results: ToolResult[],
    reply: string,
  ): void {
    const { guard } = this.deps;
    const { session } = conversation;

    // The parser lower-cases the user's words. The Guard masks a value it has already seen in
    // this conversation however it is written, so the arguments are safe to keep.
    const scrubArgs = (value: unknown): unknown => {
      if (typeof value === 'string') return guard.scrub(value, session).text;
      if (Array.isArray(value)) return value.map(scrubArgs);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubArgs(v)]));
      }
      return value;
    };

    // Only the calls that ran: a failure stops the rest of a compound command.
    const calls = results.map((result, index) => ({
      id: randomUUID(),
      name: planned[index]!.name,
      args: scrubArgs(planned[index]!.args) as Record<string, unknown>,
      result,
    }));
    conversation.messages.push(
      { role: 'assistant', toolCalls: calls.map(({ id, name, args }) => ({ id, name, args })) },
      {
        role: 'tool',
        results: calls.map(({ id, name, result }) => ({
          id,
          name,
          // No data: the spoken sentence is enough for a command that needed no AI.
          content: guard.scrubJson(
            {
              ok: result.ok,
              message: result.cancelled
                ? 'The user said no when asked to confirm, so this was not done.'
                : result.speak,
            },
            session,
            result.fromScreen ? { maskContactInfo: true } : {},
          ),
        })),
      },
      { role: 'assistant', text: guard.scrub(reply, session).text },
    );
  }

  private async runLlm(
    conversation: Conversation,
    ctx: Parameters<ToolExecutor['execute']>[1],
  ): Promise<string> {
    const { router, registry, executor, guard, emit } = this.deps;
    // Facts the user asked Aida to remember (never sensitive: the memory refuses those).
    const facts = this.deps.memory?.promptFacts() ?? [];
    const system = facts.length
      ? PrivacyGuard.join(
          SYSTEM_PROMPT,
          PrivacyGuard.constant(' The user asked you to remember: '),
          guard.scrub(facts.join('; '), conversation.session).text,
          PrivacyGuard.constant('.'),
        )
      : SYSTEM_PROMPT;

    // Only the tools this conversation is likely to need (plus a way to ask for more).
    const groups = selectGroups(
      conversation.messages.flatMap((m) => (m.role === 'user' ? [m.text] : [])),
      conversation.messages.flatMap((m) =>
        m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.name) : [],
      ),
    );

    // What each action of this request said, over every pass, in the order they ran. A request
    // that takes several passes reports all of it, not only the last pass's part.
    const spoken: string[] = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const missing = groups ? GROUP_NAMES.filter((g) => !groups.has(g)) : [];
      const tools = registry.specs((name) => isSelected(name, groups));
      if (missing.length > 0) tools.push(moreToolsSpec(missing));
      const response = await router.complete(
        { system, messages: conversation.messages, tools },
        ctx.requestId,
        ctx.signal,
        ctx.trace,
      );

      conversation.messages.push({
        role: 'assistant',
        text: response.text ? guard.scrub(response.text, conversation.session).text : undefined,
        toolCalls: response.toolCalls,
        raw: response.raw,
      });

      // The model has seen every result, so its own words win; without any, say what was done.
      if (response.toolCalls.length === 0) return response.text || spoken.join(' ') || 'Done.';

      const results: { id: string; name: string; result: ToolResult }[] = [];
      for (const call of response.toolCalls) {
        if (call.name === MORE_TOOLS) {
          // Handled here, not by a tool: the next request carries the groups asked for.
          const added = requestedGroups(call.args).filter((g) => !groups?.has(g));
          for (const g of added) groups?.add(g);
          results.push({
            id: call.id,
            name: call.name,
            result: {
              ok: added.length > 0,
              // The model tends to re-issue the calls it made alongside this one, which would
              // run them twice ("skip" skipping two songs): say they are done.
              speak: added.length
                ? `Added tools for: ${added.join(', ')}. Your other calls in this reply have already run; do not repeat them.`
                : 'No such tool group; use the tools you have.',
              followUp: true,
            },
          });
          continue;
        }
        emit({
          type: 'status',
          requestId: ctx.requestId,
          text: `Running ${call.name.replace('_', ' ')}…`,
        });
        results.push({ id: call.id, name: call.name, result: await executor.execute(call, ctx) });
      }
      conversation.messages.push({
        role: 'tool',
        results: results.map(({ id, name, result }) => ({
          id,
          name,
          content: guard.scrubJson(
            { ok: result.ok, message: result.speak, data: result.data },
            conversation.session,
            result.fromScreen ? { maskContactInfo: true } : {},
          ),
        })),
      });

      if (results.some((r) => r.result.cancelled)) return "Okay, I won't do that.";
      // Only actions that worked are said aloud. A result marked followUp is something the model
      // was asked to read (a list, a failure, the more_tools acknowledgement), not something to say.
      for (const { result } of results) {
        if (result.ok && !result.followUp) spoken.push(result.speak);
      }
      // Tools already know what to say; skip the extra round trip unless the model needs to look.
      // Not for a model that takes one step per reply (D-029): it expects to be asked again, and
      // finishing here would drop the rest of a multi-step request.
      if (!response.stepwise && results.every((r) => r.result.ok && !r.result.followUp))
        return spoken.join(' ');
      emit({ type: 'status', requestId: ctx.requestId, text: 'Thinking…' });
    }
    return "I couldn't finish that in a reasonable number of steps.";
  }

  /** Close the turn so the next message alternates correctly for every provider. */
  private closeTurn(conversation: Conversation, text: string): void {
    const last = conversation.messages.at(-1);
    if (last && last.role !== 'assistant')
      conversation.messages.push({
        role: 'assistant',
        text: this.deps.guard.scrub(text, conversation.session).text,
      });
  }

  private reply(requestId: string, conversation: Conversation, text: string, ok: boolean): string {
    const { guard, log, emit } = this.deps;
    this.closeTurn(conversation, text);
    log.write({ type: 'reply', requestId, text: guard.scrub(text, conversation.session).text });
    emit({ type: 'reply', requestId, text, ok });
    return text;
  }
}
