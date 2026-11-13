import type { TraceEntry } from '../src/main/trace/tracer';
import type { VoiceLogEntry } from '../src/main/voice/diagnostics';

export type LoggedTrace = TraceEntry & { ts?: string };

export interface StageSummary {
  count: number;
  median: number;
  p95: number;
}

export interface TraceSummary {
  requests: number;
  failed: number;
  voice: number;
  routes: Record<string, StageSummary>;
  stages: Record<'stt' | 'llm' | 'tool' | 'tts', StageSummary>;
  llmCallsPerRequest: number;
  inputTokensPerCall: number;
  toolsOfferedPerCall: number;
  models: Record<
    string,
    { requests: number; failed: number; inputTokens: number; outputTokens: number }
  >;
  failures: Record<string, number>;
  toolFailures: Record<string, number>;
  perDay: Record<string, { requests: number; llmRequests: number; tokens: number }>;
}

export type LoggedVoice = VoiceLogEntry & { ts?: string };

export interface VoiceSummary {
  heard: number;
  outcomes: Record<string, number>;
  voice: {
    checked: number;
    rejected: number;
    nearMisses: number;
    lowest: number;
    median: number;
    highest: number;
    threshold: number | null;
  };
  commands: {
    listened: number;
    accepted: number;
    timeouts: number;
    empty: number;
    veryShort: number;
  };
  sttMedian: number;
  sttP95: number;
}

export function summarizeVoice(heard: LoggedVoice[]): VoiceSummary;
export function renderVoice(summary: VoiceSummary, days: number): string;
export function readVoice(dir: string, days: number, now?: Date): LoggedVoice[];
export function percentile(values: number[], p: number): number;
export function summarize(traces: LoggedTrace[]): TraceSummary;
export function render(summary: TraceSummary, days: number): string;
export function readTraces(dir: string, days: number, now?: Date): LoggedTrace[];
