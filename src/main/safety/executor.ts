import type { PlaceholderSession, PrivacyGuard } from '../privacy/guard';
import type { ToolRegistry } from '../tools/registry';
import type { ToolResult } from '../tools/types';
import type { JsonlLog } from './action-log';

export type CommandSource = 'palette' | 'voice' | 'remote';

export interface ConfirmRequest {
  id: string;
  requestId: string;
  /** Where the command came from, so voice commands can be confirmed by voice. */
  source: CommandSource;
  /** Already scrubbed: sensitive values appear as placeholders, never in plain text. */
  summary: string;
  /** The action would type or send a real sensitive value from the placeholder vault. */
  usesSensitiveValue: boolean;
}

export type Confirmer = (request: ConfirmRequest) => Promise<boolean>;

export interface ExecuteContext {
  requestId: string;
  source: CommandSource;
  session: PlaceholderSession;
  activeWindow: number | null;
  signal: AbortSignal;
}

export interface ToolCallRequest {
  name: string;
  args: unknown;
}

/**
 * The single place tools run. Order: find tool → fill placeholders back in locally → validate →
 * permission gate (risk level, or any real sensitive value) → run → log (scrubbed).
 */
export class ToolExecutor {
  private confirmCounter = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly guard: PrivacyGuard,
    private readonly confirm: Confirmer,
    private readonly log: JsonlLog,
  ) {}

  async execute(call: ToolCallRequest, ctx: ExecuteContext): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool || tool.risk === 'blocked') {
      return this.finish(ctx, call.name, call.name, {
        ok: false,
        speak: `I can't do that (${call.name} isn't available).`,
        followUp: true,
      });
    }

    const { value: rawArgs, usedSensitive } = this.guard.rehydrate(call.args ?? {}, ctx.session);
    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return this.finish(ctx, tool.name, tool.name, {
        ok: false,
        speak: `I couldn't understand the details for that (${issue?.path.join('.') || 'input'}: ${issue?.message}).`,
        followUp: true,
      });
    }

    const summary = this.guard.scrub(tool.describe(parsed.data), ctx.session).text;

    const ask = async (text: string, usesSensitiveValue: boolean) => {
      if (ctx.signal.aborted) return false;
      const scrubbedText = this.guard.scrub(text, ctx.session).text;
      const approved = await this.confirm({
        id: `confirm-${++this.confirmCounter}`,
        requestId: ctx.requestId,
        source: ctx.source,
        summary: scrubbedText,
        usesSensitiveValue,
      });
      this.log.write({
        type: 'confirm',
        requestId: ctx.requestId,
        summary: scrubbedText,
        approved,
      });
      return approved;
    };

    if (tool.risk === 'confirm' || usedSensitive) {
      if (!(await ask(summary, usedSensitive))) {
        return { ok: false, cancelled: true, speak: "Okay, I won't do that." };
      }
    }

    try {
      const result = await tool.run(parsed.data, {
        activeWindow: ctx.activeWindow,
        signal: ctx.signal,
        confirm: (text) => ask(text, false),
      });
      return this.finish(ctx, tool.name, summary, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.finish(ctx, tool.name, summary, {
        ok: false,
        speak: `That didn't work: ${message}`,
        followUp: true,
      });
    }
  }

  private finish(
    ctx: ExecuteContext,
    tool: string,
    summary: string,
    result: ToolResult,
  ): ToolResult {
    this.log.write({
      type: 'tool',
      requestId: ctx.requestId,
      tool,
      summary: this.guard.scrub(summary, ctx.session).text,
      ok: result.ok,
      result: this.guard.scrub(result.speak, ctx.session).text,
    });
    return result;
  }
}
