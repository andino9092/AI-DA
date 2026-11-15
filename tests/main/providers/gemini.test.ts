import { describe, expect, it } from 'vitest';
import { PrivacyGuard } from '../../../src/main/privacy/guard';
import { toContents } from '../../../src/main/providers/llm/gemini';
import type { ChatMessage } from '../../../src/main/providers/llm/types';

describe('Gemini: history that did not come from Gemini', () => {
  it('sends a locally handled command as a function call and its response', () => {
    // What the assistant records after "open spotify" is handled without the AI (D-027).
    const history: ChatMessage[] = [
      { role: 'user', text: PrivacyGuard.constant('open spotify') },
      { role: 'assistant', toolCalls: [{ id: 'x1', name: 'open_app', args: { name: 'spotify' } }] },
      {
        role: 'tool',
        results: [
          {
            id: 'x1',
            name: 'open_app',
            content: PrivacyGuard.constant('{"ok":true,"message":"Opening Spotify."}'),
          },
        ],
      },
      { role: 'assistant', text: PrivacyGuard.constant('Opening Spotify.') },
      { role: 'user', text: PrivacyGuard.constant('now close it') },
    ];
    expect(toContents(history, 'gemini-test')).toEqual([
      { role: 'user', parts: [{ text: 'open spotify' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'x1', name: 'open_app', args: { name: 'spotify' } },
            // No Gemini thought signature exists for a call Gemini never made.
            thoughtSignature: 'skip_thought_signature_validator',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'x1',
              name: 'open_app',
              response: { output: '{"ok":true,"message":"Opening Spotify."}' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'Opening Spotify.' }] },
      { role: 'user', parts: [{ text: 'now close it' }] },
    ]);
  });
});
