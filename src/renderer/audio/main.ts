import type { AudioCommand, ListenMode } from '@shared/voice';
import { DEFAULT_SEGMENTER, SpeechSegmenter } from '@shared/speech-segmenter';
import { Player } from './player';
import { SileroVad } from './vad';

/**
 * Hidden window that owns the microphone and speakers. Speech is cut into utterances locally
 * (Silero VAD); only those utterances go to the main process, which transcribes them locally.
 */
const voice = window.aida.voice;
const COMMAND_TIMEOUT_MS = 7000;
const LEVEL_INTERVAL_MS = 66;

let mode: ListenMode = 'off';
let deviceId: string | null = null;
let vad: SileroVad | null = null;
let stream: MediaStream | null = null;
let capture: AudioContext | null = null;
let commandTimer: number | undefined;
let lastLevelAt = 0;
let processing: Promise<void> = Promise.resolve();

const segmenter = new SpeechSegmenter(DEFAULT_SEGMENTER);
const player = new Player((id) => voice.sendEvent({ type: 'playback-finished', id }));

function segmenterFor(m: ListenMode) {
  // Commands allow longer pauses mid-sentence than the wake phrase check does.
  segmenter.configure({ endSilenceMs: m === 'command' ? 800 : 640 });
}

async function openMic(): Promise<void> {
  closeMic();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    capture = new AudioContext({ sampleRate: 16_000 });
    await capture.audioWorklet.addModule(new URL('../capture-worklet.js', location.href).href);
    const source = capture.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(capture, 'aida-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const frame = e.data;
      processing = processing.then(() => onFrame(frame));
    };
    source.connect(node);
    voice.sendEvent({ type: 'mic-state', open: true });
  } catch (err) {
    closeMic();
    voice.sendEvent({
      type: 'mic-state',
      open: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function closeMic(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void capture?.close();
  capture = null;
  segmenter.reset();
  vad?.reset();
}

async function onFrame(frame: Float32Array): Promise<void> {
  if (!vad || mode === 'off') return;
  const probability = await vad.probability(frame);
  const event = segmenter.push(frame, probability);

  if (mode === 'command' || segmenter.isSpeaking) {
    const now = performance.now();
    if (now - lastLevelAt > LEVEL_INTERVAL_MS) {
      lastLevelAt = now;
      let sum = 0;
      for (const s of frame) sum += s * s;
      voice.sendEvent({ type: 'level', rms: Math.min(1, Math.sqrt(sum / frame.length) * 8) });
    }
  }

  if (event?.type === 'start') {
    window.clearTimeout(commandTimer);
    voice.sendEvent({ type: 'speech-start', mode });
  } else if (event?.type === 'end') {
    voice.sendUtterance({ mode, samples: event.samples });
  } else if (event?.type === 'discard' && mode === 'command') {
    armCommandTimeout();
  }
}

function armCommandTimeout(): void {
  window.clearTimeout(commandTimer);
  commandTimer = window.setTimeout(
    () => voice.sendEvent({ type: 'command-timeout' }),
    COMMAND_TIMEOUT_MS,
  );
}

async function ensureVad(): Promise<boolean> {
  if (vad) return true;
  try {
    vad = await SileroVad.create(await voice.getVadModel());
    return true;
  } catch (err) {
    voice.sendEvent({
      type: 'error',
      message: `Voice detector failed to load: ${err instanceof Error ? err.message : String(err)}`,
    });
    return false;
  }
}

async function applyConfig(next: ListenMode, nextDevice: string | null): Promise<void> {
  if (next !== 'off' && !(await ensureVad())) next = 'off';
  const deviceChanged = nextDevice !== deviceId;
  const wasOpen = mode !== 'off';
  mode = next;
  deviceId = nextDevice;
  segmenterFor(mode);
  window.clearTimeout(commandTimer);
  if (mode === 'off') {
    closeMic();
    voice.sendEvent({ type: 'mic-state', open: false });
    return;
  }
  if (!wasOpen || deviceChanged || !stream) await openMic();
  if (mode === 'command') {
    segmenter.reset();
    armCommandTimeout();
  }
}

voice.onCommand((command: AudioCommand) => {
  switch (command.type) {
    case 'config':
      void applyConfig(command.mode, command.deviceId);
      break;
    case 'play':
      player.play(command.id, command.samples, command.sampleRate);
      break;
    case 'end-of-speech':
      player.endOfSpeech(command.id);
      break;
    case 'stop-playback':
      player.stop();
      break;
    case 'chime':
      player.chime(command.chime);
      break;
  }
});

// The voice detector loads on first use, so playback works even before it's installed.
voice.sendEvent({ type: 'ready' });
