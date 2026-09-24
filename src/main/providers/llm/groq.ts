import Groq, { APIError } from 'groq-sdk';
import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { randomUUID } from 'node:crypto';
import {
  classifyStatus,
  ProviderError,
  stripThinking,
  type ChatMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './types';

const TIMEOUT_MS = 20_000;

function toMessages(system: string, messages: ChatMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    } else {
      out.push({
        role: 'assistant',
        content: m.text ?? '',
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

/** Speed matters more than deep reasoning for desktop commands. */
function reasoningEffort(model: string): 'none' | 'low' | undefined {
  if (model.startsWith('qwen/')) return 'none';
  if (model.startsWith('openai/gpt-oss')) return 'low';
  return undefined;
}

export class GroqProvider implements LlmProvider {
  readonly id = 'groq' as const;
  private readonly client: Groq;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Groq({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  }

  async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    try {
      const effort = reasoningEffort(this.model);
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toMessages(request.system, request.messages),
          tools: request.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: 'auto',
          temperature: 0.2,
          ...(effort ? { reasoning_effort: effort } : {}),
        },
        { signal },
      );
      const message = completion.choices[0]?.message;
      const toolCalls = (message?.tool_calls ?? []).map((c) => ({
        id: c.id || randomUUID(),
        name: c.function.name,
        args: parseArgs(c.function.arguments),
      }));
      return { text: stripThinking(message?.content ?? ''), toolCalls };
    } catch (err) {
      if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.');
      if (err instanceof APIError) {
        const retry = Number(err.headers?.get('retry-after'));
        throw new ProviderError(
          classifyStatus(err.status),
          `Groq: ${err.message}`,
          Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
          err.status,
        );
      }
      throw new ProviderError(
        'unavailable',
        `Groq: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
