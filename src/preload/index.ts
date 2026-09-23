import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AidaApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';

const api: AidaApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    onChanged: (listener) => {
      const wrapped = (_event: IpcRendererEvent, settings: Settings) => listener(settings);
      ipcRenderer.on(IPC.settingsChanged, wrapped);
      return () => ipcRenderer.removeListener(IPC.settingsChanged, wrapped);
    },
  },
  secrets: {
    list: () => ipcRenderer.invoke(IPC.secretsList),
    set: (name, value) => ipcRenderer.invoke(IPC.secretsSet, name, value),
    remove: (name) => ipcRenderer.invoke(IPC.secretsRemove, name),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    chooseFolder: (defaultPath) => ipcRenderer.invoke(IPC.chooseFolder, defaultPath),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  },
};

contextBridge.exposeInMainWorld('aida', api);
