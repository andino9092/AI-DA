import { ApiError, GoogleGenAI, type Content, type Part } from '@google/genai';
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

/**
 * Gemini 3 requires the thought signature of each function call to be sent back. Turns that came
 * from another provider have none, and Google documents this value for exactly that case.
 */
const FOREIGN_SIGNATURE = 'skip_thought_signature_validator';
const TIMEOUT_MS = 20_000;

function toContents(messages: ChatMessage[]): Content[] {
  return messages.map((m): Content => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: { id: r.id, name: r.name, response: { output: r.content } },
        })),
      };
    }
    if (m.raw?.provider === 'gemini') return m.raw.content as Content;
    const parts: Part[] = [];
    if (m.text) parts.push({ text: m.text });
    for (const call of m.toolCalls ?? []) {
      parts.push({
        functionCall: { id: call.id, name: call.name, args: call.args },
        thoughtSignature: FOREIGN_SIGNATURE,
      });
    }
    return { role: 'model', parts };
  });
}

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT_MS } });
  }

  async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: toContents(request.messages),
        config: {
          abortSignal: signal,
          systemInstruction: request.system,
          tools: [
            {
              functionDeclarations: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        },
      });

      const content = response.candidates?.[0]?.content;
      const parts = content?.parts ?? [];
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join('');
      const toolCalls = parts
        .filter((p) => p.functionCall?.name)
        .map((p) => ({
          id: p.functionCall!.id ?? randomUUID(),
          name: p.functionCall!.name!,
          args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
        }));

      // Keep our generated ids in the replayed turn so function responses line up.
      const replay: Content | undefined = content && {
        role: 'model',
        parts: parts.map((p) => {
          if (!p.functionCall?.name) return p;
          const call = toolCalls.find(
            (c) =>
              c.name === p.functionCall!.name &&
              (!p.functionCall!.id || c.id === p.functionCall!.id),
          );
          return { ...p, functionCall: { ...p.functionCall, id: call?.id } };
        }),
      };

      return {
        text: stripThinking(text),
        toolCalls,
        raw: replay ? { provider: 'gemini', content: replay } : undefined,
      };
    } catch (err) {
      if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.');
      if (err instanceof ApiError) {
        throw new ProviderError(
          classifyStatus(err.status),
          `Gemini: ${err.message}`,
          retryAfter(err.message),
          err.status,
        );
      }
      throw new ProviderError(
        'unavailable',
        `Gemini: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Gemini puts "retryDelay": "12s" in the error body of 429s. */
function retryAfter(message: string): number | undefined {
  const m = /retry(?:Delay)?["\s:]+"?(\d+(?:\.\d+)?)s/i.exec(message);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}
