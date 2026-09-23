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
  offline: 'Offline',
};
