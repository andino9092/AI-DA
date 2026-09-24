import { z } from 'zod';
import { defineTool } from '../types';

/** A place the forecast is for. */
export interface Place {
  /** "Toronto, Ontario, Canada" */
  name: string;
  latitude: number;
  longitude: number;
}

export type TemperatureUnit = 'celsius' | 'fahrenheit';

type FetchJson = (url: string, signal?: AbortSignal) => Promise<unknown>;

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 8000;
const CACHE_MS = 10 * 60 * 1000;

const geocodeSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

const forecastSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()),
  }),
});

export type Forecast = z.infer<typeof forecastSchema>;

/** WMO weather codes (Open-Meteo) → words that read well aloud. */
const CONDITIONS: Record<number, string> = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'cloudy',
  45: 'foggy',
  48: 'foggy',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'rain showers',
  81: 'rain showers',
  82: 'heavy rain showers',
  85: 'snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with hail',
};

export function condition(code: number): string {
  return CONDITIONS[code] ?? 'mixed weather';
}

async function defaultFetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Open-Meteo: free, no key, no account. Only the city (or its coordinates) is sent, never an IP
 * lookup; the city is one the user typed in Settings or said.
 */
export class WeatherClient {
  private readonly cache = new Map<string, { at: number; forecast: Forecast }>();

  constructor(
    private readonly fetchJson: FetchJson = defaultFetchJson,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * "Toronto" or "Springfield, Illinois" → the best match, or null. Words after a comma pick
   * between places with the same name.
   */
  async geocode(query: string, signal?: AbortSignal): Promise<Place | null> {
    const [city = '', ...hints] = query.split(',').map((p) => p.trim().toLowerCase());
    if (!city) return null;
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;
    const { results = [] } = geocodeSchema.parse(await this.fetchJson(url, signal));
    const matchesHints = (r: (typeof results)[number]) =>
      hints.every((h) =>
        [r.admin1, r.country].some((part) => part?.toLowerCase().startsWith(h) ?? false),
      );
    const best = results.find(matchesHints) ?? (hints.length ? undefined : results[0]);
    if (!best) return null;
    return {
      name: [best.name, best.admin1, best.country]
        .filter((p, i, all): p is string => !!p && all.indexOf(p) === i)
        .join(', '),
      latitude: best.latitude,
      longitude: best.longitude,
    };
  }

  async forecast(place: Place, unit: TemperatureUnit, signal?: AbortSignal): Promise<Forecast> {
    const key = `${place.latitude},${place.longitude},${unit}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.forecast;
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: '7',
      temperature_unit: unit,
      wind_speed_unit: unit === 'fahrenheit' ? 'mph' : 'kmh',
    });
    const forecast = forecastSchema.parse(
      await this.fetchJson(`${FORECAST_URL}?${params}`, signal),
    );
    this.cache.set(key, { at: this.now(), forecast });
    return forecast;
  }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Which forecast day the user means: 0 = today. "now" and unknown words → null (current
 * conditions). Weekday names mean the next such day (today counts).
 */
export function dayIndex(when: string | undefined, today: Date): number | 'now' | 'week' | null {
  const w = (when ?? 'now').toLowerCase().trim();
  if (!w || /^(?:now|right now|currently|outside|at the moment)$/.test(w)) return 'now';
  if (/^(?:today|this (?:morning|afternoon|evening)|tonight)$/.test(w)) return 0;
  if (/^tomorrow(?: (?:morning|afternoon|evening|night))?$/.test(w)) return 1;
  if (/^(?:this |the )?(?:week|weekend|next few days|week ahead)$/.test(w)) return 'week';
  const day = WEEKDAYS.findIndex((d) => w.replace(/^(?:on |this |next )/, '').startsWith(d));
  if (day >= 0) return (day - today.getDay() + 7) % 7;
  return null;
}

function degrees(value: number): string {
  return `${Math.round(value)} degrees`;
}

function rainChance(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value < 20) return ' Rain is unlikely.';
  return ` ${Math.round(value / 10) * 10} percent chance of rain.`;
}

/** Turns a forecast into one or two short spoken sentences. */
export function describeForecast(
  forecast: Forecast,
  place: string,
  when: number | 'now' | 'week',
  today: Date,
): string {
  const { current, daily } = forecast;
  if (when === 'now') {
    const feels =
      Math.abs(current.apparent_temperature - current.temperature_2m) >= 3
        ? `, feels like ${Math.round(current.apparent_temperature)}`
        : '';
    return (
      `It's ${degrees(current.temperature_2m)}${feels} and ${condition(current.weather_code)} in ${place}. ` +
      `Today's high is ${Math.round(daily.temperature_2m_max[0]!)}.` +
      rainChance(daily.precipitation_probability_max[0])
    );
  }
  if (when === 'week') {
    const days = daily.time.length;
    const highs = daily.temperature_2m_max;
    const warmest = highs.indexOf(Math.max(...highs));
    const wet = daily.precipitation_probability_max
      .map((p, i) => ((p ?? 0) >= 50 ? i : -1))
      .filter((i) => i >= 0)
      .map((i) => dayName(i, today));
    return (
      `Over the next ${days} days in ${place}, highs range from ${Math.round(Math.min(...highs))} to ${degrees(Math.max(...highs))}, warmest ${dayName(warmest, today)}. ` +
      (wet.length ? `Rain is likely ${listWords(wet)}.` : 'No rainy days are expected.')
    );
  }
  if (when >= daily.time.length)
    return `I only have the forecast for the next ${daily.time.length} days.`;
  const label = when === 0 ? 'Today' : capitalize(dayName(when, today));
  return (
    `${label} in ${place}: ${condition(daily.weather_code[when]!)}, ` +
    `high of ${Math.round(daily.temperature_2m_max[when]!)} and low of ${degrees(daily.temperature_2m_min[when]!)}.` +
    rainChance(daily.precipitation_probability_max[when])
  );
}

function dayName(offset: number, today: Date): string {
  if (offset === 0) return 'today';
  if (offset === 1) return 'tomorrow';
  return capitalize(WEEKDAYS[(today.getDay() + offset) % 7]!);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

export interface WeatherDeps {
  client: WeatherClient;
  /** The home city from Settings → Weather, or null if none is set. */
  home: () => Place | null;
  unit: () => TemperatureUnit;
  now?: () => Date;
}

export function weatherTools({ client, home, unit, now = () => new Date() }: WeatherDeps) {
  return [
    defineTool({
      name: 'get_weather',
      description:
        'Weather now or the forecast for up to 7 days (temperature, conditions, chance of rain). Uses the home city from Settings unless the user names a place.',
      risk: 'safe',
      input: z.object({
        when: z
          .string()
          .optional()
          .describe('"now", "today", "tomorrow", a weekday like "saturday", or "week"'),
        place: z.string().min(1).optional().describe('City, only if the user named one'),
      }),
      describe: ({ when, place }) =>
        `Check the weather${place ? ` in ${place}` : ''}${when ? ` ${when}` : ''}`,
      run: async ({ when, place }, ctx) => {
        const today = now();
        const day = dayIndex(when, today);
        if (day === null)
          return { ok: false, speak: `I can only check up to a week ahead.`, followUp: true };
        let target = home();
        try {
          if (place) {
            target = await client.geocode(place, ctx.signal);
            if (!target) return { ok: false, speak: `I couldn't find a place called ${place}.` };
          }
          if (!target)
            return {
              ok: false,
              speak: 'Set your city in Settings → Weather first, or ask for a city by name.',
            };
          const forecast = await client.forecast(target, unit(), ctx.signal);
          const shortName = target.name.split(',')[0]!;
          return { ok: true, speak: describeForecast(forecast, shortName, day, today) };
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { ok: false, speak: "I couldn't reach the weather service right now." };
        }
      },
    }),
  ];
}
