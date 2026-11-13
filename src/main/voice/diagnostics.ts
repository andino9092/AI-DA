/**
 * What happened to one thing the microphone picked up, for finding out why "Hey Aida" or a
 * command was missed (D-021). Numbers and labels only: never the transcript or the audio.
 * Written only while Settings → Voice → "Record voice diagnostics" is on.
 */
export type VoiceOutcome =
  /** A command was understood and run. */
  | 'accepted'
  /** "Hey Aida" on its own: now listening for the command. */
  | 'wake only'
  /** "Hey Aida" heard over continuous sound: listening for the rest of the sentence. */
  | 'wake, more to come'
  /** The wake phrase matched, but not in the owner's voice. */
  | 'rejected: voice'
  /** No wake phrase in it: speech that wasn't for Aida. */
  | 'not addressed'
  /** The wake phrase matched, but the wake word is off or voice samples are being recorded. */
  | 'wake not acted on'
  /** A new "Hey Aida" while a command was still running. */
  | 'busy'
  /** Listening for a command and nothing usable was transcribed. */
  | 'empty'
  /** "Hey Aida" again while already listening. */
  | 'repeated wake'
  /** "Stop", "never mind". */
  | 'stop'
  /** Transcription failed. */
  | 'stt error'
  /** Listened for a command and none came. */
  | 'timeout';

export interface VoiceDiagnostic {
  outcome: VoiceOutcome;
  /** Whether Aida was waiting for "Hey Aida" or for a command. */
  mode: 'wake' | 'command';
  /** Length of the audio. Absent for a timeout: nothing was heard. */
  seconds?: number;
  /** Loudest point, in dB below full scale (0 is as loud as the mic goes). */
  peakDb?: number;
  /** The transcript contained the wake phrase (before the voice check). */
  wakeMatched?: boolean;
  /** How much it sounded like the owner, and what it needed to reach. */
  voiceScore?: number;
  threshold?: number;
  /** From the end of speech to the transcript being ready. */
  sttMs?: number;
  /** Words in the transcript: a count, not the words. */
  words?: number;
  /** A window cut from continuous sound (music, TV). */
  cut?: boolean;
}

export type VoiceLogEntry = { type: 'heard' } & VoiceDiagnostic;
