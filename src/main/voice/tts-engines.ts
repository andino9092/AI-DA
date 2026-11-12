import { utilityProcess } from 'electron';
import type { TtsResponse } from '@shared/tts-protocol';
import type { AudioWindow } from '../app/audio-window';
import type { TtsEngine } from './tts';

/** Kokoro on the CPU in a utility process: slower, but works on any PC. */
export function cpuEngine(workerPath: string): TtsEngine {
  return {
    name: 'cpu',
    initTimeoutMs: 120_000,
    create: () => {
      const proc = utilityProcess.fork(workerPath, [], {
        serviceName: 'AI-DA voice',
        stdio: 'ignore',
      });
      return {
        post: (message) => proc.postMessage(message),
        listen: (onMessage, onExit) => {
          proc.on('message', onMessage);
          proc.on('exit', onExit);
        },
        stop: () => proc.kill(),
      };
    },
  };
}

/**
 * Kokoro on the graphics card, in a worker inside the hidden audio window. `responses` delivers
 * that window's voice-engine messages.
 */
export function gpuEngine(
  audio: Pick<AudioWindow, 'send' | 'onPageGone'>,
  responses: (listener: (message: TtsResponse) => void) => () => void,
): TtsEngine {
  return {
    name: 'gpu',
    // Loading plus compiling for the graphics card; a few seconds on a typical PC.
    initTimeoutMs: 60_000,
    create: () => {
      const unsubscribe: (() => void)[] = [];
      return {
        post: (request) => audio.send({ type: 'tts', request }),
        listen: (onMessage, onExit) => {
          unsubscribe.push(responses(onMessage), audio.onPageGone(onExit));
        },
        stop: () => {
          for (const off of unsubscribe.splice(0)) off();
        },
      };
    },
  };
}
