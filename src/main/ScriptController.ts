import { app } from 'electron';
import path from 'path';
import {
  uIOhook,
  UiohookKeyboardEvent,
  UiohookMouseEvent,
  UiohookWheelEvent,
  UiohookKey,
} from 'uiohook-napi';

import robot from '@hurdlegroup/robotjs'
import fs from 'fs';

import StreamArray from 'stream-json/streamers/StreamArray'
import { keyMap } from './keyMap';




export interface KeyEvent {
  type: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  keyCode: number;
}

export class ScriptController {
  // Path to script folder
  private scriptPath: string;

  // Boolean telling whether or not to make it look like human activity
  private haveDelay: boolean;
  private actionLog: any[];
  private scriptRunning: boolean;
  private logToFile(scriptName: string) {
    const filePath = path.join(this.scriptPath, scriptName + '.json');
    fs.writeFile(filePath, JSON.stringify(this.actionLog), (err) =>
      console.log(err),
    );
    this.actionLog = [];
  }

  private addListeners() {
    const makeMod = (
      e: UiohookKeyboardEvent | UiohookMouseEvent | UiohookWheelEvent,
    ) => {
      let mods: string[] = [];
      e.altKey && mods.push('alt');
      e.ctrlKey && mods.push('ctrl');
      e.metaKey && mods.push('meta');
      e.shiftKey && mods.push('shift');
      return mods;
    };
    // TODO: Determine what is string and what is just shortcut
    const keyListener = (e: UiohookKeyboardEvent) => {
      console.log(e)
      let keyEvent = {
        type: 'key',
        keyCode: e.keycode,
        mods: makeMod(e),
      };

      this.actionLog.push(keyEvent);
    };
    const mouseMoveListener = (e: UiohookMouseEvent) => {
      const mouseMoveEvent = {
        type: 'mouseMove',
        x: e.x,
        y: e.y,
        mods: makeMod(e),
      };
      this.actionLog.push(mouseMoveEvent);
    };

    const mouseDownListener = (e: UiohookMouseEvent) => {
      const mouseDownEvent = {
        type: Number(e.button) > 1 ? 'rightMouseDown': 'leftMouseDown',
        mods: makeMod(e),
      }
      this.actionLog.push(mouseDownEvent);
    };

    const wheelListener = (e: UiohookWheelEvent) => {
      const mouseScrollEvent = {
        type: 'scroll',
        mods: makeMod(e),
        direction: e.direction == 3 ? 'x': 'y',
        negative: e.rotation < 1,
        magnitude: e.amount,
      }
      this.actionLog.push(mouseScrollEvent)
    };

    uIOhook.on('keydown', keyListener)
    uIOhook.on('mousemove', mouseMoveListener);
    uIOhook.on('mousedown', mouseDownListener)
    uIOhook.on('wheel', wheelListener);
  };

  constructor() {
    // might have to change this later when building electron app due to packaging to another file
    this.scriptPath = path.join(__dirname, '../../userScripts');
    if (!fs.existsSync(this.scriptPath)) {
      fs.mkdirSync(this.scriptPath);
    }
    this.haveDelay = true;
    this.actionLog = [];
    this.scriptRunning = true;
    this.addListeners();
  }

  recordScript() {
    console.log('starting');
    uIOhook.start();


    setTimeout(() => {
      uIOhook.stop();
      this.logToFile('testScript');
    }, 2000);
  }

  runScript() {
    const scriptPath = path.join(this.scriptPath, 'testScript.json')
    const jsonStream = StreamArray.withParser();

    const readStream = fs.createReadStream(scriptPath);
    readStream.pipe(jsonStream);

    jsonStream.on('data', ({key, value}) => {
      console.log(value)
      if (value.type == 'mouseMove'){
        robot.moveMouse(value.x, value.y)
      }
      else if (value.type == 'key'){
        robot.keyTap(keyMap[value.keyCode]);
      }

    })
    console.log('running')
  }
}
;
