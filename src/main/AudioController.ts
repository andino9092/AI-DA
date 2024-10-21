import robot from '@hurdlegroup/robotjs';
import os from 'os'

export class AudioController {
  private stepValue = 0;


  constructor() {
    const platform = os.platform();
    if (platform == 'darwin'){
      this.stepValue = 6
    }
    else if (platform == 'win32'){
      this.stepValue = 2
    }
  }
  // Positive -> Increase volume
  // Negative -> Decrease volume
  changeVolume(netChange: number): void {
    const numSteps = Math.abs(netChange) / this.stepValue;
    for (let i = 0; i < numSteps; i++) {
      if (netChange > 0) {
        robot.keyTap('audio_vol_up');
      } else {
        robot.keyTap('audio_vol_down');
      }
    }
  }

  mute(): void {
    robot.keyTap('audio_mute');
  }

  unmute(): void {
    robot.keyTap('audio_vol_up');
    robot.keyTap('audio_vol_down');
  }

  play(): void {
    robot.keyTap('audio_play');
  }

  pause(): void {
    robot.keyTap('audio_pause');
  }

  goNext(): void {
    robot.keyTap('audio_next');
  }

  goPrev(): void {
    robot.keyTap('audio_prev');
  }
}
