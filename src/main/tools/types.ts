import type { z } from 'zod';

/** safe: runs immediately · confirm: asks the user first · blocked: never runs. */
export type Risk = 'safe' | 'confirm' | 'blocked';

export interface ToolContext {
  /** The window that was in front before AI-DA's own UI opened ("snap this left"). */
  activeWindow: number | null;
  signal: AbortSignal;
  /**
   * Asks the user mid-run, for when the risk is only known after looking (the button turned out
   * to be "Send"). Resolves false if declined or unanswered.
   */
  confirm(summary: string): Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  /** A short sentence AI-DA can say as-is, so most commands need no second LLM round trip. */
  speak: string;
  /** Extra detail for the LLM (lists, suggestions). Always scrubbed before it leaves the PC. */
  data?: unknown;
  /** Ask the LLM to look at this result before replying (lists, "did you mean", failures). */
  followUp?: boolean;
  /** The user declined the confirmation. */
  cancelled?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: Risk;
  input: S;
  /** Human-readable summary for confirmations and logs, e.g. "Close Spotify". */
  describe(args: z.output<S>): string;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

// The registry stores tools with different schemas side by side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;
