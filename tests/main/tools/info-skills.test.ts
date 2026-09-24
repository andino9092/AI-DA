import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TimerService,
  parseClockTime,
  timerMessage,
  timerTools,
} from '../../../src/main/tools/info/timers';
import {
  WeatherClient,
  condition,
  dayIndex,
  describeForecast,
  weatherTools,
  type Forecast,
} from '../../../src/main/tools/info/weather';
import { convert, findUnit } from '../../../src/main/tools/info/units';
import type { AnyTool, ToolContext } from '../../../src/main/tools/types';
import { tempDir } from '../fakes';

const ctx = (): ToolContext => ({
  activeWindow: null,
  signal: new AbortController().signal,
  confirm: async () => true,
});
const tool = (tools: AnyTool[], name: string) => tools.find((t) => t.name === name)!;
const run = (t: AnyTool, args: unknown) => t.run(t.input.parse(args), ctx());

// Thursday 24 September 2026, 3:00 pm local time.
const NOW = new Date(2026, 8, 24, 15, 0, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute, 0);

describe('clock times', () => {
  it.each([
    ['7 am', at(25, 7)],
    ['at 5', at(24, 17)],
    ['5 pm', at(24, 17)],
    ['4', at(24, 16)],
    ['7:30 p.m.', at(24, 19, 30)],
    ['19:00', at(24, 19)],
    ['noon', at(25, 12)],
    ['midnight', at(25, 0)],
    ['half past 6', at(24, 18, 30)],
    ['quarter to eight', at(24, 19, 45)],
    ['tomorrow at 9', at(25, 9)],
    ['6 in the morning', at(25, 6)],
    ['ten tonight', at(24, 22)],
    ["8 o'clock", at(24, 20)],
  ])('%s', (text, expected) => {
    expect(parseClockTime(text, NOW)).toEqual(expected);
  });

  it.each(['the laundry', '25:00', '7:75', '13 pm', ''])('rejects "%s"', (text) => {
    expect(parseClockTime(text, NOW)).toBeNull();
  });

  it('sets alarms and announces them', async () => {
    const service = new TimerService(
      join(tempDir(), 't.json'),
      () => {},
      () => NOW.getTime(),
    );
    const tools = timerTools(service, () => NOW.getTime());
    const result = await run(tool(tools, 'set_alarm'), { time: '7 am' });
    expect(result.ok).toBe(true);
    expect(result.speak).toMatch(/^Alarm set for 7:00\sAM tomorrow\.$/);
    const [alarm] = service.list();
    expect(alarm!.alarm).toBe(true);
    expect(alarm!.endsAt).toBe(at(25, 7).getTime());
    expect(timerMessage(alarm!, false)).toMatch(/^It's 7:00\sAM\. This is your alarm\.$/);
    expect((await run(tool(tools, 'list_timers'), {})).speak).toMatch(/alarm is set for 7:00\sAM/);

    const reminder = await run(tool(tools, 'set_alarm'), { time: '5 pm', label: 'call mom' });
    expect(reminder.speak).toMatch(/^Okay, I'll remind you at 5:00\sPM\.$/);
    service.dispose();
  });
});

const FORECAST: Forecast = {
  current: {
    temperature_2m: 18.4,
    apparent_temperature: 14.9,
    weather_code: 2,
    wind_speed_10m: 12,
  },
  daily: {
    time: [
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
    ],
    weather_code: [2, 61, 0, 3, 80, 1, 0],
    temperature_2m_max: [21, 16, 23, 19, 17, 20, 22],
    temperature_2m_min: [12, 10, 11, 12, 9, 10, 13],
    precipitation_probability_max: [10, 80, 0, 30, 60, 5, null],
  },
};

describe('weather', () => {
  it('reads forecast days', () => {
    expect(dayIndex(undefined, NOW)).toBe('now');
    expect(dayIndex('today', NOW)).toBe(0);
    expect(dayIndex('tomorrow morning', NOW)).toBe(1);
    expect(dayIndex('saturday', NOW)).toBe(2);
    expect(dayIndex('on thursday', NOW)).toBe(0);
    expect(dayIndex('this weekend', NOW)).toBe('week');
    expect(dayIndex('next month', NOW)).toBeNull();
    expect(condition(95)).toBe('thunderstorms');
  });

  it('describes the weather in short sentences', () => {
    expect(describeForecast(FORECAST, 'Toronto', 'now', NOW)).toBe(
      "It's 18 degrees, feels like 15 and partly cloudy in Toronto. Today's high is 21. Rain is unlikely.",
    );
    expect(describeForecast(FORECAST, 'Toronto', 1, NOW)).toBe(
      'Tomorrow in Toronto: light rain, high of 16 and low of 10 degrees. 80 percent chance of rain.',
    );
    expect(describeForecast(FORECAST, 'Toronto', 3, NOW)).toBe(
      'Sunday in Toronto: cloudy, high of 19 and low of 12 degrees. 30 percent chance of rain.',
    );
    expect(describeForecast(FORECAST, 'Toronto', 'week', NOW)).toBe(
      'Over the next 7 days in Toronto, highs range from 16 to 23 degrees, warmest Saturday. Rain is likely tomorrow and Monday.',
    );
  });

  it('looks up the city and asks Open-Meteo, caching the forecast', async () => {
    const urls: string[] = [];
    const client = new WeatherClient(async (url) => {
      urls.push(url);
      if (url.includes('geocoding'))
        return {
          results: [
            {
              name: 'Springfield',
              latitude: 37.2,
              longitude: -93.3,
              admin1: 'Missouri',
              country: 'United States',
            },
            {
              name: 'Springfield',
              latitude: 39.8,
              longitude: -89.6,
              admin1: 'Illinois',
              country: 'United States',
            },
          ],
        };
      return FORECAST;
    });
    const place = await client.geocode('Springfield, Illinois');
    expect(place).toEqual({
      name: 'Springfield, Illinois, United States',
      latitude: 39.8,
      longitude: -89.6,
    });
    expect(urls[0]).toContain('name=springfield');

    const tools = weatherTools({
      client,
      home: () => place,
      unit: () => 'fahrenheit',
      now: () => NOW,
    });
    const result = await run(tool(tools, 'get_weather'), { when: 'tomorrow' });
    expect(result).toEqual({
      ok: true,
      speak:
        'Tomorrow in Springfield: light rain, high of 16 and low of 10 degrees. 80 percent chance of rain.',
    });
    await run(tool(tools, 'get_weather'), {});
    const forecasts = urls.filter((u) => u.includes('forecast'));
    expect(forecasts).toHaveLength(1);
    expect(forecasts[0]).toContain('temperature_unit=fahrenheit');
    expect(forecasts[0]).toContain('latitude=39.8');
  });

  it('asks for a city when none is set, and says when the service is down', async () => {
    const down = new WeatherClient(async () => {
      throw new Error('offline');
    });
    const noHome = weatherTools({ client: down, home: () => null, unit: () => 'celsius' });
    expect((await run(tool(noHome, 'get_weather'), {})).speak).toMatch(/Settings → Weather/);
    const withHome = weatherTools({
      client: down,
      home: () => ({ name: 'Oslo, Norway', latitude: 59.9, longitude: 10.7 }),
      unit: () => 'celsius',
    });
    expect(await run(tool(withHome, 'get_weather'), {})).toEqual({
      ok: false,
      speak: "I couldn't reach the weather service right now.",
    });
  });
});

describe('unit conversion', () => {
  it.each([
    [5, 'miles', 'km', '5 miles is 8.05 kilometers.'],
    [70, 'fahrenheit', 'celsius', '70 degrees Fahrenheit is 21.1 degrees Celsius.'],
    [1, 'liter', 'cups', '1 liter is 4.23 cups.'],
    [200, 'grams', 'ounces', '200 grams is 7.05 ounces.'],
    [6, 'feet', 'meters', '6 feet is 1.83 meters.'],
    [100, 'km/h', 'mph', '100 kilometers per hour is 62.1 miles per hour.'],
    [2, 'tablespoons', 'teaspoons', '2 tablespoons is 6 teaspoons.'],
    [1, 'inch', 'cm', '1 inch is 2.54 centimeters.'],
    [1500, 'meters', 'km', '1,500 meters is 1.5 kilometers.'],
  ])('%s %s → %s', (value, from, to, text) => {
    expect(convert(value, from, to)).toMatchObject({ ok: true, text });
  });

  it('knows spoken unit names', () => {
    expect(findUnit('Degrees Fahrenheit')).toBe('f');
    expect(findUnit('inches')).toBe('in');
    expect(findUnit('kilometres per hour')).toBe('kmh');
    expect(findUnit('lbs')).toBe('lb');
    expect(findUnit('apples')).toBeNull();
  });

  it('refuses mismatched units', () => {
    expect(convert(1, 'kg', 'miles')).toEqual({
      ok: false,
      error: "I can't convert kilograms to miles.",
    });
  });
});
