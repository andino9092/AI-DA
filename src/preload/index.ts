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
    testKey: (provider) => ipcRenderer.invoke(IPC.llmTest, provider),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    chooseFolder: (defaultPath) => ipcRenderer.invoke(IPC.chooseFolder, defaultPath),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  },
  models: {
    status: () => ipcRenderer.invoke(IPC.modelsStatus),
    install: () => ipcRenderer.invoke(IPC.modelsInstall),
    onChanged: (listener) => subscribe(IPC.modelsChanged, listener),
  },
  voice: {
    onCommand: (listener) => subscribe(IPC.voiceCommand, listener),
    sendEvent: (event) => ipcRenderer.send(IPC.voiceEvent, event),
    sendUtterance: (utterance) => ipcRenderer.send(IPC.voiceUtterance, utterance),
    getVadModel: () => ipcRenderer.invoke(IPC.voiceVadModel),
    onOverlay: (listener) => subscribe(IPC.overlayState, listener),
    test: () => ipcRenderer.invoke(IPC.voiceTest),
    monitor: (enabled) => ipcRenderer.invoke(IPC.voiceMonitor, enabled),
    onMonitor: (listener) => subscribe(IPC.voiceMonitorEvent, listener),
    idStatus: () => ipcRenderer.invoke(IPC.voiceIdStatus),
    idRecord: (add) => ipcRenderer.invoke(IPC.voiceIdRecord, add === true),
    idSave: () => ipcRenderer.invoke(IPC.voiceIdSave),
    idCancel: () => ipcRenderer.invoke(IPC.voiceIdCancel),
    idClear: () => ipcRenderer.invoke(IPC.voiceIdClear),
  },
  weather: {
    findPlace: (city) => ipcRenderer.invoke(IPC.weatherFindPlace, city),
  },
  memory: {
    list: () => ipcRenderer.invoke(IPC.memoryList),
    remove: (ids) => ipcRenderer.invoke(IPC.memoryRemove, ids),
    clear: () => ipcRenderer.invoke(IPC.memoryClear),
    onChanged: (listener) => subscribe(IPC.memoryChanged, listener),
  },
  spotify: {
    status: () => ipcRenderer.invoke(IPC.spotifyStatus),
    connect: () => ipcRenderer.invoke(IPC.spotifyConnect),
    disconnect: () => ipcRenderer.invoke(IPC.spotifyDisconnect),
  },
  notifications: {
    snapshot: () => ipcRenderer.invoke(IPC.notificationsSnapshot),
    setGoogleClient: (clientId, clientSecret) =>
      ipcRenderer.invoke(IPC.notificationsSetClient, clientId, clientSecret),
    clearGoogleClient: () => ipcRenderer.invoke(IPC.notificationsClearClient),
    connect: () => ipcRenderer.invoke(IPC.notificationsConnect),
    disconnect: () => ipcRenderer.invoke(IPC.notificationsDisconnect),
    test: () => ipcRenderer.invoke(IPC.notificationsTest),
    unmute: () => ipcRenderer.invoke(IPC.notificationsUnmute),
    onChanged: (listener) => subscribe(IPC.notificationsChanged, listener),
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
