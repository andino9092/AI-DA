import {
  VAD_THRESHOLDS,
  type AudioCommand,
  type ListenMode,
  type WakeSensitivity,
} from '@shared/voice';
import { DEFAULT_HOLD, HoldRecorder } from '@shared/hold-recorder';
import { DEFAULT_SEGMENTER, SpeechSegmenter } from '@shared/speech-segmenter';
import type { TtsRequest, TtsResponse } from '@shared/tts-protocol';
import { Player } from './player';
import { SileroVad } from './vad';

/**
 * Hidden window that owns the microphone and speakers. Speech is cut into utterances locally
 * (Silero VAD); only those utterances go to the main process, which transcribes them locally.
 */
const voice = window.aida.voice;
const COMMAND_TIMEOUT_MS = 7000;
const LEVEL_INTERVAL_MS = 66;

type MicSource = 'browser' | 'system';

let mode: ListenMode = 'off';
/** Where the microphone comes from: opened here, or echo-cancelled by Windows (mic-audio). */
let source: MicSource = 'browser';
const FRAME_SAMPLES = 512;
let deviceId: string | null = null;
let sensitivity: WakeSensitivity = 'normal';
/** Settings → Mic check is open: report the level all the time, not just while speaking. */
let meter = false;
/** Push-to-talk is held: only releasing it ends the command. */
let hold = false;
let vad: SileroVad | null = null;
let stream: MediaStream | null = null;
let capture: AudioContext | null = null;
let commandTimer: number | undefined;
let lastLevelAt = 0;
let processing: Promise<void> = Promise.resolve();
/** Numbers each stretch of speech, so a pause's early transcript matches its final one. */
let segment = 0;

const segmenter = new SpeechSegmenter(DEFAULT_SEGMENTER);
const recorder = new HoldRecorder(DEFAULT_HOLD);
/** The last ~0.4 s of audio, so a push-to-talk recording includes the first syllable. */
const RECENT_FRAMES = 12;
const recent: { frame: Float32Array; probability: number }[] = [];
const player = new Player((id) => voice.sendEvent({ type: 'playback-finished', id }));

/** The graphics-card voice engine, started on the first request from the main process. */
let ttsWorker: Worker | null = null;

function ttsRequest(request: TtsRequest): void {
  if (!ttsWorker) {
    ttsWorker = new Worker(new URL('./tts-gpu-worker.ts', import.meta.url), { type: 'module' });
    ttsWorker.onmessage = (e: MessageEvent<TtsResponse>) =>
      voice.sendEvent({ type: 'tts', response: e.data });
    ttsWorker.onerror = (e) => {
      voice.sendEvent({ type: 'tts', response: { type: 'error', message: e.message } });
      ttsWorker?.terminate();
      ttsWorker = null;
    };
  }
  ttsWorker.postMessage(request);
}

function configureSegmenter() {
  const { positive, negative } = VAD_THRESHOLDS[sensitivity];
  segmenter.configure({
    // Commands allow longer pauses mid-sentence than the wake phrase check does.
    endSilenceMs: mode === 'command' ? 800 : 640,
    positiveThreshold: positive,
    negativeThreshold: negative,
    // Start transcribing after a short pause instead of waiting for the end.
    speculateMs: 320,
    // Music or a TV can keep the speech detector busy: check it in overlapping 6 s windows so
    // "Hey Aida" is still noticed. Commands aren't cut.
    cutMs: mode === 'wake' ? 6000 : 0,
    overlapMs: 2000,
  });
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
  recorder.cancel();
  recent.length = 0;
  vad?.reset();
}

async function onFrame(frame: Float32Array): Promise<void> {
  if (!vad || mode === 'off') return;
  const probability = await vad.probability(frame);
  recent.push({ frame, probability });
  if (recent.length > RECENT_FRAMES) recent.shift();

  if (meter || mode === 'command' || segmenter.isSpeaking) reportLevel(frame);

  if (recorder.active) {
    // Holding push-to-talk: record everything; releasing the key (or the length limit) ends it.
    if (recorder.push(frame, probability)) flush();
    return;
  }
  const event = segmenter.push(frame, probability);

  if (event?.type === 'start') {
    segment++;
    window.clearTimeout(commandTimer);
    voice.sendEvent({ type: 'speech-start', mode });
  } else if (event?.type === 'pause') {
    voice.sendUtterance({ mode, samples: event.samples, segment, tentative: true });
  } else if (event?.type === 'end') {
    voice.sendUtterance({
      mode,
      samples: event.samples,
      segment,
      ...(event.sameAsPause ? { reuse: true } : {}),
      ...(event.cut ? { cut: true } : {}),
    });
    // A cut window's speech goes on as a new stretch.
    if (event.cut) segment++;
  } else if (event?.type === 'discard' && mode === 'command') {
    armCommandTimeout();
  }
}

function reportLevel(frame: Float32Array): void {
  const now = performance.now();
  if (now - lastLevelAt <= LEVEL_INTERVAL_MS) return;
  lastLevelAt = now;
  let sum = 0;
  for (const s of frame) sum += s * s;
  voice.sendEvent({ type: 'level', rms: Math.min(1, Math.sqrt(sum / frame.length) * 8) });
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

async function applyConfig(
  next: ListenMode,
  nextDevice: string | null,
  nextSensitivity: WakeSensitivity,
  nextMeter: boolean,
  nextHold: boolean,
  nextSource: MicSource,
): Promise<void> {
  if (next !== 'off' && !(await ensureVad())) next = 'off';
  const deviceChanged = nextDevice !== deviceId;
  const sourceChanged = nextSource !== source;
  source = nextSource;
  const wasOpen = mode !== 'off';
  const wasCommand = mode === 'command';
  mode = next;
  deviceId = nextDevice;
  sensitivity = nextSensitivity;
  meter = nextMeter;
  hold = nextHold && next === 'command';
  if (!hold && recorder.active) {
    // A quick tap: hand what was recorded to the speech detector, which then decides the end.
    for (const r of recorder.cancel()) segmenter.push(r.frame, r.probability);
  }
  configureSegmenter();
  window.clearTimeout(commandTimer);
  if (mode === 'off') {
    closeMic();
    voice.sendEvent({ type: 'mic-state', open: false });
    return;
  }
  const reopened =
    !wasOpen || sourceChanged || (source === 'browser' && (deviceChanged || !stream));
  if (reopened) {
    if (source === 'browser') await openMic();
    else {
      // Windows' echo canceller owns the mic; its audio arrives as mic-audio.
      closeMic();
      voice.sendEvent({ type: 'mic-state', open: true });
    }
  }
  if (mode === 'command') {
    // Entering command mode starts fresh; changing hold or the meter mid-command must not drop
    // what's being said. Holding push-to-talk records until it's released. After "Hey Aida" in
    // a window cut from continuous sound, the sentence is still going: keep what came after.
    if (!wasCommand) {
      if (segmenter.continuesCut) segmenter.dropOverlap();
      else segmenter.reset();
    }
    if (hold && !recorder.active) recorder.start(reopened ? [] : recent);
    if (!hold && !segmenter.isSpeaking) armCommandTimeout();
  }
}

/** Push-to-talk released: everything recorded while it was held is the command. */
function flush(): void {
  if (recorder.active) {
    const samples = recorder.finish(VAD_THRESHOLDS[sensitivity].positive);
    if (samples) voice.sendUtterance({ mode: 'command', samples });
    else voice.sendEvent({ type: 'no-speech' });
    return;
  }
  processing = processing.then(() => {
    const event = segmenter.flush();
    if (event?.type === 'end') voice.sendUtterance({ mode, samples: event.samples });
    else armCommandTimeout();
  });
}

voice.onCommand((command: AudioCommand) => {
  switch (command.type) {
    case 'config':
      void applyConfig(
        command.mode,
        command.deviceId,
        command.sensitivity,
        command.meter,
        command.hold,
        command.source,
      );
      break;
    case 'mic-audio':
      if (source !== 'system' || mode === 'off') break;
      for (let i = 0; i + FRAME_SAMPLES <= command.samples.length; i += FRAME_SAMPLES) {
        const frame = command.samples.slice(i, i + FRAME_SAMPLES);
        processing = processing.then(() => onFrame(frame));
      }
      break;
    case 'play':
      player.play(command.id, command.samples, command.sampleRate);
      break;
    case 'end-of-speech':
      player.endOfSpeech(command.id);
      break;
    case 'flush':
      flush();
      break;
    case 'stop-playback':
      player.stop();
      break;
    case 'chime':
      player.chime(command.chime);
      break;
    case 'tts':
      ttsRequest(command.request);
      break;
  }
});

// The voice detector loads on first use, so playback works even before it's installed.
voice.sendEvent({ type: 'ready' });
