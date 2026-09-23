import type { AidaApi } from '@shared/ipc';

declare global {
  interface Window {
    aida: AidaApi;
  }
}
