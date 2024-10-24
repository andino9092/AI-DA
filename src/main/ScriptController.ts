import { app } from 'electron';
import path from 'path';
import {
  uIOhook,
  UiohookKeyboardEvent,
  UiohookMouseEvent,
  UiohookWheelEvent,
  UiohookKey,
} from 'uiohook-napi';

import robot from '@hurdlegroup/robotjs';
import fs from 'fs';

import StreamArray from 'stream-json/streamers/StreamArray';
import { keyMap } from './keyMap';
import { timeStamp } from 'console';

export interface KeyEvent {
  type: string;
  time: number;
  keyCode: number;
  mods: string[];
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
    // TODO: Improve how to track things. For example, how to know whether or not your holding down a key
    const keyListener = (e: UiohookKeyboardEvent) => {
      if (
        e.keycode == UiohookKey.Shift ||
        e.keycode == UiohookKey.ShiftRight ||
        e.keycode == UiohookKey.CtrlRight ||
        e.keycode == UiohookKey.Meta ||
        e.keycode == UiohookKey.MetaRight ||
        e.keycode == UiohookKey.Alt ||
        e.keycode == UiohookKey.AltRight ||
        e.keycode == UiohookKey.Ctrl
      ) {
        return;
      }
      let keyEvent: KeyEvent = {
        type: 'key',
        time: Math.round(e.time / 1000000),
        keyCode: e.keycode,
        mods: makeMod(e),
      };

      this.actionLog.push(keyEvent);
    };
    const mouseMoveListener = (e: UiohookMouseEvent) => {
      const mouseMoveEvent = {
        type: 'mouseMove',
        time: Math.round(e.time / 1000000),
        x: e.x,
        y: e.y,
        mods: makeMod(e),
      };
      this.actionLog.push(mouseMoveEvent);
    };

    const mouseDownListener = (e: UiohookMouseEvent) => {
      const mouseDownEvent = {
        type: 'mouseDown',
        time: Math.round(e.time / 1000000),
        side: Number(e.button) > 1 ? 'right' : 'left',
        mods: makeMod(e),
      };
      this.actionLog.push(mouseDownEvent);
    };

    const wheelListener = (e: UiohookWheelEvent) => {
      const mouseScrollEvent = {
        type: 'scroll',
        mods: makeMod(e),
        time: Math.round(e.time / 1000000),
        direction: e.direction == 4 ? 'x' : 'y',
        negative: e.rotation < 1,
        magnitude: e.amount,
      };
      this.actionLog.push(mouseScrollEvent);
    };

    uIOhook.on('keydown', keyListener);
    uIOhook.on('mousemove', mouseMoveListener);
    uIOhook.on('mousedown', mouseDownListener);
    uIOhook.on('wheel', wheelListener);
  }

  constructor() {
    // might have to change this later when building electron app due to packaging to another folder
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
    uIOhook.on('keydown', (e: UiohookKeyboardEvent) => {
      if (e.keycode == UiohookKey.Q) {
        console.log('stopping');
        this.logToFile('testing');
        uIOhook.stop();
      }
    });
  }
  static genInstructionFunc = (value: any) => {
    if (value.type == 'mouseMove') {
      return () => robot.moveMouse(value.x, value.y);
    } else if (value.type == 'key') {
      return () => robot.keyTap(keyMap[value.keyCode], [...value.mods]);
    } else if (value.type == 'mouseDown') {
      console.log(value);
      return () => robot.mouseClick(value.side);
    } else if (value.type == 'scroll') {
      const sign = value.negative ? -1 : 1;
      if (value.direction == 'x') {
        return () => robot.scrollMouse(sign * value.magnitude, 0);
      } else {
        return () => robot.scrollMouse(0, sign * value.magnitude);
      }
    }
    return () => console.log('Doesnt match types');
  };

  runScript() {
    const scriptPath = path.join(this.scriptPath, 'testing.json');
    const jsonStream = StreamArray.withParser();

    const readStream = fs.createReadStream(scriptPath);
    readStream.pipe(jsonStream);

    let firstTime: number | undefined;
    jsonStream.on('data', ({ key, value }) => {
      console.log(value);
      const timeoutFunc = ScriptController.genInstructionFunc(value);
      if (firstTime) {
        const timeStamp = Math.round(value.time - firstTime);
        setTimeout(() => {
          timeoutFunc();
        }, timeStamp);
      } else {
        timeoutFunc();
        firstTime = value.time;
      }
    });
    jsonStream.on('end', () => {
      console.log('finished script');
    });
  }
}
