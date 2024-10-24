/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */

import path from 'path';
import { Worker } from 'worker_threads';
import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { AudioController } from './AudioController';
import { ResponseHandler } from './ResponseHandler';
import { uIOhook, UiohookKey, UiohookKeyboardEvent } from 'uiohook-napi';

export const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../../assets');

const intentPath = path.join(RESOURCES_PATH, 'scripts', 'intenter.js');
export const intentWorker = new Worker(intentPath);
const promptPath = path.join(RESOURCES_PATH, 'scripts', 'prompter.js')
export const promptWorker = new Worker(promptPath)



const intentHandler = new ResponseHandler();



intentWorker.postMessage({
  action: 'start',
})

intentWorker.on('message', (msg) => {
  console.log(msg);
  if (msg.response == 'closed') {
    intentWorker.terminate().then(() => console.log('worker closed'));
  } else if (msg.response == 'intent') {
    try {
      intentHandler.handleIntent(msg.content.intent, msg.content.slots);
    } catch (error) {
      console.log(error);
    }
  }
})

setTimeout(() => {
  intentHandler.recordScript(intentWorker, promptWorker);

}, 2000)

// intentHandler.testScript()
