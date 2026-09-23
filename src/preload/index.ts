import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AidaApi } from '@shared/ipc';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: AidaApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    onChanged: (listener) => subscribe(IPC.settingsChanged, listener),
  },
  secrets: {
    list: () => ipcRenderer.invoke(IPC.secretsList),
    set: (name, value) => ipcRenderer.invoke(IPC.secretsSet, name, value),
    remove: (name) => ipcRenderer.invoke(IPC.secretsRemove, name),
  },
  privacy: {
    list: () => ipcRenderer.invoke(IPC.privacyList),
    add: (label, value) => ipcRenderer.invoke(IPC.privacyAdd, label, value),
    remove: (id) => ipcRenderer.invoke(IPC.privacyRemove, id),
  },
  llm: {
    usage: () => ipcRenderer.invoke(IPC.llmUsage),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    chooseFolder: (defaultPath) => ipcRenderer.invoke(IPC.chooseFolder, defaultPath),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  },
  palette: {
    submit: (text) => ipcRenderer.invoke(IPC.paletteSubmit, text),
    confirm: (confirmId, approved) => ipcRenderer.invoke(IPC.paletteConfirm, confirmId, approved),
    hide: () => ipcRenderer.invoke(IPC.paletteHide),
    onEvent: (listener) => subscribe(IPC.assistantEvent, listener),
    onShown: (listener) => subscribe(IPC.paletteShown, listener),
  },
};

contextBridge.exposeInMainWorld('aida', api);
