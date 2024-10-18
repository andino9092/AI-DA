import robot from '@hurdlegroup/robotjs'


export class AudioController {

    private stepValue = 2;

    // Positive -> Increase volume
    // Negative -> Decrease volume
    changeVolume(netChange: number): void{
        const numSteps = Math.abs(netChange) / this.stepValue
        for (let i = 0; i < numSteps; i ++){
            if (netChange > 0){
                robot.keyTap('audio_vol_up')
            }
            else{
                robot.keyTap('audio_vol_down')
            }
        }
    }

    mute(): void{
        robot.keyTap('mute');
    }

    play(): void{
        robot.keyTap('play');
    }

    pause(): void{
        robot.keyTap('pause');
    }

    goNext(): void{
      robot.keyTap('')
    }

}
