import { useEffect, useState } from 'react';
import type { ModelStatus } from '@shared/models';

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Download state of the local voice models, kept live while the window is open. */
export function useModels(): ModelStatus[] {
  const [models, setModels] = useState<ModelStatus[]>([]);
  useEffect(() => {
    void window.aida.models.status().then(setModels);
    return window.aida.models.onChanged(setModels);
  }, []);
  return models;
}

/** The speech detector, Whisper and the Kokoro voice are installed. */
export function listenReady(models: ModelStatus[]): boolean {
  return ['vad', 'whisper-runtime', 'whisper-model'].every((id) =>
    models.some((m) => m.id === id && m.state === 'ready'),
  );
}
