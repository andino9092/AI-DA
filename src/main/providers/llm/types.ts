import type { ScrubbedText } from '../../privacy/guard';
import type { ToolSpec } from '../../tools/registry';

export type ProviderId = 'gemini' | 'groq';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Provider-neutral conversation. Every piece of text is `ScrubbedText`: the type system is what
 * stops raw user or screen data from reaching a provider.
 */
export type ChatMessage =
  | { role: 'user'; text: ScrubbedText }
  | {
      role: 'assistant';
      text?: ScrubbedText;
      toolCalls?: ToolCall[];
      /** The provider's own turn (e.g. Gemini thought signatures), replayed only to that provider. */
      raw?: { provider: ProviderId; content: unknown };
    }
  | { role: 'tool'; results: { id: string; name: string; content: ScrubbedText }[] };

export interface LlmRequest {
  system: ScrubbedText;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface LlmResponse {
  /** Model output. Not scrubbed: it came from the provider, not from the PC. */
  text: string;
  toolCalls: ToolCall[];
  raw?: { provider: ProviderId; content: unknown };
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

export type ProviderErrorKind = 'rate_limit' | 'auth' | 'unavailable' | 'bad_request' | 'aborted';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    /** HTTP status, when the provider answered with an error. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Maps HTTP status codes from any SDK to a small set of routing decisions. */
export function classifyStatus(status: number | undefined): ProviderErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  return 'unavailable';
}

/** Some models (e.g. Qwen) inline their reasoning; it is never shown or spoken. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
