import type { MemoryStore } from '../src/main/memory/memory';
import type { TimerService } from '../src/main/tools/info/timers';
import type { Routine } from '../src/shared/settings';
import type { FakeWindows } from '../tests/main/fakes';

/** Where a command was handled: by the local parser, by the cloud model, or as a saved routine. */
export type Route = 'instant' | 'llm' | 'routine';

export type Category =
  /** One tool does it. */
  | 'single'
  /** Several tools in one request. */
  | 'multi'
  /** A second turn that only makes sense after the first. */
  | 'follow-up'
  /** The app is described, not named ("my music app"). See D-011. */
  | 'described'
  /** Not enough to act on: Aida should ask. */
  | 'ambiguous'
  /** Nothing AI-DA can do: Aida should say so and change nothing. */
  | 'impossible'
  /** Needs a confirmation first. */
  | 'risky'
  /** A sensitive value must never reach the model. */
  | 'privacy'
  /** The answer needs information from a tool, then the model's own words. */
  | 'lookup';

/** The simulated PC a task runs against. Real tools act on it; graders read it afterwards. */
export interface EvalWorld {
  pc: FakeWindows;
  /** App ids that were launched. */
  launched: string[];
  /** Web addresses that were opened. */
  opened: string[];
  memory: MemoryStore;
  timers: TimerService;
  routines: Routine[];
}

export interface Expectation {
  /** Where each turn should be handled, in order. Fewer entries than turns checks only the first ones. */
  routes?: Route[];
  /** Tools that must each have run successfully at least once. */
  tools?: string[];
  /** Tools that must not have run at all. */
  forbid?: string[];
  /** No tool may have run. */
  noToolCalls?: true;
  /** Whether a confirmation must (true) or must not (false) have been asked. */
  confirms?: boolean;
  /** The last reply must end with a question. */
  asksQuestion?: true;
  /** The last reply must match. */
  reply?: RegExp;
  /** Text that must never appear in anything sent to the model. */
  neverSent?: string[];
  /**
   * Most model round trips allowed across the whole task, for a model that batches its tool
   * calls. A stepwise model is allowed one more per tool it ran.
   */
  maxLlmCalls?: number;
  /** The simulated PC must end up like this. */
  state?: (world: EvalWorld) => boolean;
}

export interface EvalTask {
  id: string;
  category: Category;
  /** Changes to the default simulated PC before the task starts. */
  setup?: (world: EvalWorld) => void;
  /** What the user says, one entry per turn. */
  say: string[];
  /** The answer given to every confirmation. Default: yes. */
  approve?: boolean;
  expect: Expectation;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  /** The tool asked the model to look at its result. */
  followUp: boolean;
}

export interface TurnRecord {
  said: string;
  reply: string;
  route: Route | null;
}

/** Everything one run of one task did. */
export interface RunRecord {
  turns: TurnRecord[];
  toolCalls: ToolCallRecord[];
  confirms: { summary: string; approved: boolean }[];
  /** Model round trips. */
  llmCalls: number;
  /** Size of everything sent to the model, in characters. */
  requestChars: number;
  /** Tokens the provider counted across the task's round trips (0 if it doesn't report them). */
  inputTokens: number;
  outputTokens: number;
  /** Time spent waiting for the model, without pauses for rate limits. */
  llmMs: number;
  /** The tool names offered to the model on each round trip. */
  toolsOffered: string[][];
  /** Every request to the model as text, for the "never sent" rule. */
  sent: string[];
  /** The model was run in one-step-per-reply mode, which costs a request per step. */
  stepwise: boolean;
  /** Set when the run broke instead of finishing (provider down, harness error). */
  error?: string;
  /** Set when the provider refused the request because the model wrote an invalid tool call. */
  rejected?: string;
}

export interface Grade {
  pass: boolean;
  /** The rules that did not hold, e.g. "state", "tools: set_volume". */
  failed: string[];
}
