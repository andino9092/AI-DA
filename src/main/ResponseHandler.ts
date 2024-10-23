import { fetchWeatherApi } from 'openmeteo';
import { AudioController } from './AudioController';
import { ScriptController } from './ScriptController';

interface Slot {
  [slotName: string]: string;
}

export interface MappedResponse {
  [intent: string]: (slot: Slot, intent?: string) => any;
}

export interface MapCoords {
  latitude: number;
  longitude: number;
}

export class ResponseHandler {
  private audioCtrl: AudioController;
  private scriptCtrl: ScriptController;
  private mappedFunctions: MappedResponse;
  private currLocation: string | undefined;
  private searchParams: any | undefined;

  private handleChangeVolume(slot: Slot, intent?: string) {
    console.log(slot);
    if (slot && Object.keys(slot).length == 0) {
      if (intent == 'lowerVolume') {
        this.audioCtrl?.changeVolume(-8);
      } else {
        this.audioCtrl?.changeVolume(8);
      }
    } else {
      if (intent == 'lowerVolume') {
        this.audioCtrl?.changeVolume(-Number(slot.decrease));
      } else {
        this.audioCtrl?.changeVolume(Number(slot.increase));
      }
    }
  }

  private getWeather() {
    console.log('Getting the weather. Give me a second...');
    fetchWeatherApi(
      'https://api.open-meteo.com/v1/forecast',
      this.searchParams,
    ).then((responses: any) => {
      // Process first location. Add a for-loop for multiple locations or weather models
      const response = responses[0];

      // Attributes for timezone and location
      const utcOffsetSeconds = response.utcOffsetSeconds();
      const timezone = response.timezone();
      const timezoneAbbreviation = response.timezoneAbbreviation();
      const latitude = response.latitude();
      const longitude = response.longitude();

      const current = response.current()!;
      const hourly = response.hourly()!;
      const daily = response.daily()!;
      const weatherData = {
        current: {
          time: new Date((Number(current.time()) + utcOffsetSeconds) * 1000),
          temperature2m: current.variables(0)!.value(),
          rain: current.variables(1)!.value(),
        },
      };

      console.log(weatherData.current.temperature2m)
      console.log(latitude, longitude)
    });
  }

  private recordScript(){
    this.scriptCtrl?.recordScript();
  }

  constructor() {
    this.currLocation = 'Brooklyn';
    this.audioCtrl = new AudioController();
    this.scriptCtrl = new ScriptController();
    this.mappedFunctions = {
      lowerVolume: (slot: Slot) => this.handleChangeVolume(slot, 'lowerVolume'),
      increaseVolume: (slot: Slot) =>
        this.handleChangeVolume(slot, 'increaseVolume'),
      muteSound: (_: Slot) => this.audioCtrl?.mute(),
      playSound: (_: Slot) => this.audioCtrl?.play(),
      unmuteSound: (_: Slot) => this.audioCtrl?.unmute(),
      pauseSound: (_: Slot) => this.audioCtrl?.pause(),
      runScript: (_: Slot) => {},
      getWeather: (_: Slot) => this.getWeather(),
      recordScript: (slot: Slot) => {},
    };
    fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${this.currLocation}&count=3&language=en&format=json`,
    )
      .then((response) => response.json())
      .then((data) => {
        const result = data.results[0];
        this.searchParams = {
          latitude: result.latitude,
          longitude: result.longitude,
          current: ['temperature_2m', 'rain'],
          hourly: 'temperature_2m',
          daily: ['temperature_2m_max', 'temperature_2m_min'],
          timezone: 'auto',
          forecast_days: 1,
          temperature_unit: 'fahrenheit',
        }
      });
  }

  handleIntent(intent: string, slots: Slot): void {
    if (this.mappedFunctions) {
      this.mappedFunctions[intent](slots);
    }
  }

  testScript(){
    // const stopFunc = this.scriptCtrl.recordScript()
    // try{
    //   this.scriptCtrl.runScript();

    // }
    // catch(e){
    //   console.log(e)
    // }
  }
}



;
