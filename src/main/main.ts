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

const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../../assets');
const asset = path.join(RESOURCES_PATH, 'scripts', 'recorder.js');
;
const worker = new Worker(asset);
const intentHandler = new ResponseHandler();

worker.postMessage({
  action: 'start',
})

worker.on('message', (msg) => {
  console.log(msg);
  if (msg.response == 'closed') {
    worker.terminate().then(() => console.log('worker closed'));
  }
  else if (msg.action == 'intent'){
    try{
      intentHandler.handleIntent(msg.content.intent, msg.content.slots)

    }
    catch(error){
      console.log(error)
    }
  }
})


