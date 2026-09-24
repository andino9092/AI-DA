export const ASSISTANT_STATES = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'muted',
  'offline',
] as const;

export type AssistantState = (typeof ASSISTANT_STATES)[number];

export const ASSISTANT_STATE_LABELS: Record<AssistantState, string> = {
  idle: 'Ready',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  muted: 'Microphone muted',
  offline: 'Offline (local commands still work)',
};

/** Progress of one command, streamed to the command palette (and later the overlay). */
export type AssistantEvent =
  | { type: 'started'; requestId: string }
  | { type: 'status'; requestId: string; text: string }
  | { type: 'reply'; requestId: string; text: string; ok: boolean }
  | {
      type: 'confirm';
      requestId: string;
      confirmId: string;
      /** Scrubbed: sensitive values appear only as placeholders. */
      summary: string;
      usesSensitiveValue: boolean;
    }
  | { type: 'confirm-resolved'; requestId: string; confirmId: string };
