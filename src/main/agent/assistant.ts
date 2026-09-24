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
import { parseInstant } from './instant-parser';

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
}

export interface HandleOptions {
  source: 'palette' | 'voice' | 'remote';
  activeWindow: number | null;
  signal?: AbortSignal;
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
    const requestId = randomUUID();
    const signal = options.signal ?? new AbortController().signal;
    const conversation = this.currentConversation();
    const { guard, log, emit } = this.deps;

    const scrubbed = guard.scrub(text, conversation.session);
    log.write({ type: 'command', requestId, source: options.source, text: scrubbed.text });
    emit({ type: 'started', requestId });

    try {
      const ctx = {
        requestId,
        source: options.source,
        session: conversation.session,
        activeWindow: options.activeWindow,
        signal,
      };

      // 1. Instant path: common commands, no LLM, nothing leaves the PC.
      const planned = parseInstant(text);
      if (planned) {
        const results = await this.runInstant(planned, ctx);
        if (results) {
          log.write({ type: 'route', requestId, route: 'instant' });
          // Keep local commands in the history so follow-ups ("and make it louder") make sense.
          conversation.messages.push({ role: 'user', text: scrubbed.text });
          return this.reply(requestId, conversation, results.map((r) => r.speak).join(' '), true);
        }
      }

      // 2. LLM path: only scrubbed text is sent.
      log.write({ type: 'route', requestId, route: 'llm' });
      emit({ type: 'status', requestId, text: 'Thinking…' });
      conversation.messages.push({ role: 'user', text: scrubbed.text });
      const reply = await this.runLlm(conversation, ctx);
      return this.reply(requestId, conversation, reply, true);
    } catch (err) {
      const message =
        err instanceof NoProviderError
          ? err.message
          : err instanceof ProviderError && err.kind === 'aborted'
            ? 'Cancelled.'
            : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
      log.write({
        type: 'error',
        requestId,
        text: guard.scrub(message, conversation.session).text,
      });
      // Drop the half-finished exchange so the next request starts clean.
      this.conversation = null;
      return this.reply(requestId, conversation, message, false);
    }
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
    planned: { name: string; args: Record<string, unknown> }[],
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

  private async runLlm(
    conversation: Conversation,
    ctx: Parameters<ToolExecutor['execute']>[1],
  ): Promise<string> {
    const { router, registry, executor, guard, emit } = this.deps;

    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await router.complete(
        { system: SYSTEM_PROMPT, messages: conversation.messages, tools: registry.specs() },
        ctx.requestId,
        ctx.signal,
      );

      conversation.messages.push({
        role: 'assistant',
        text: response.text ? guard.scrub(response.text, conversation.session).text : undefined,
        toolCalls: response.toolCalls,
        raw: response.raw,
      });

      if (response.toolCalls.length === 0) return response.text || 'Done.';

      const results: { id: string; name: string; result: ToolResult }[] = [];
      for (const call of response.toolCalls) {
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
      // Tools already know what to say; skip the extra round trip unless the model needs to look.
      if (results.every((r) => r.result.ok && !r.result.followUp)) {
        return results.map((r) => r.result.speak).join(' ');
      }
      emit({ type: 'status', requestId: ctx.requestId, text: 'Thinking…' });
    }
    return "I couldn't finish that in a reasonable number of steps.";
  }

  private reply(requestId: string, conversation: Conversation, text: string, ok: boolean): string {
    const { guard, log, emit } = this.deps;
    const scrubbed = guard.scrub(text, conversation.session).text;
    // Close the turn so the next message alternates correctly for every provider.
    const last = conversation.messages.at(-1);
    if (last && last.role !== 'assistant')
      conversation.messages.push({ role: 'assistant', text: scrubbed });
    log.write({ type: 'reply', requestId, text: scrubbed });
    emit({ type: 'reply', requestId, text, ok });
    return text;
  }
}
