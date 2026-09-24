import { z } from 'zod';
import { defineTool } from '../types';

type Kind = 'length' | 'mass' | 'volume' | 'speed' | 'area' | 'data' | 'time' | 'temperature';

interface Unit {
  kind: Kind;
  /** Size in the kind's base unit (meters, grams, liters, m/s, m², bytes, seconds). */
  factor: number;
  /** Spoken singular and plural. */
  one: string;
  many: string;
}

function u(kind: Kind, factor: number, one: string, many = `${one}s`): Unit {
  return { kind, factor, one, many };
}

const UNITS: Record<string, Unit> = {
  // Length
  mm: u('length', 0.001, 'millimeter'),
  cm: u('length', 0.01, 'centimeter'),
  m: u('length', 1, 'meter'),
  km: u('length', 1000, 'kilometer'),
  in: u('length', 0.0254, 'inch', 'inches'),
  ft: u('length', 0.3048, 'foot', 'feet'),
  yd: u('length', 0.9144, 'yard'),
  mi: u('length', 1609.344, 'mile'),
  // Mass
  mg: u('mass', 0.001, 'milligram'),
  g: u('mass', 1, 'gram'),
  kg: u('mass', 1000, 'kilogram'),
  oz: u('mass', 28.349523125, 'ounce'),
  lb: u('mass', 453.59237, 'pound'),
  st: u('mass', 6350.29318, 'stone', 'stone'),
  t: u('mass', 1_000_000, 'metric ton'),
  // Volume (US customary)
  ml: u('volume', 0.001, 'milliliter'),
  l: u('volume', 1, 'liter'),
  tsp: u('volume', 0.00492892159375, 'teaspoon'),
  tbsp: u('volume', 0.01478676478125, 'tablespoon'),
  floz: u('volume', 0.0295735295625, 'fluid ounce'),
  cup: u('volume', 0.2365882365, 'cup'),
  pt: u('volume', 0.473176473, 'pint'),
  qt: u('volume', 0.946352946, 'quart'),
  gal: u('volume', 3.785411784, 'gallon'),
  // Speed
  kmh: u('speed', 1 / 3.6, 'kilometer per hour', 'kilometers per hour'),
  mph: u('speed', 0.44704, 'mile per hour', 'miles per hour'),
  ms: u('speed', 1, 'meter per second', 'meters per second'),
  kn: u('speed', 0.514444, 'knot'),
  // Area
  sqm: u('area', 1, 'square meter'),
  sqft: u('area', 0.09290304, 'square foot', 'square feet'),
  acre: u('area', 4046.8564224, 'acre'),
  ha: u('area', 10_000, 'hectare'),
  sqkm: u('area', 1_000_000, 'square kilometer'),
  sqmi: u('area', 2_589_988.110336, 'square mile'),
  // Data
  kb: u('data', 1000, 'kilobyte'),
  mb: u('data', 1e6, 'megabyte'),
  gb: u('data', 1e9, 'gigabyte'),
  tb: u('data', 1e12, 'terabyte'),
  // Time
  sec: u('time', 1, 'second'),
  min: u('time', 60, 'minute'),
  hr: u('time', 3600, 'hour'),
  day: u('time', 86_400, 'day'),
  week: u('time', 604_800, 'week'),
  // Temperature (converted separately)
  c: u('temperature', 1, 'degree Celsius', 'degrees Celsius'),
  f: u('temperature', 1, 'degree Fahrenheit', 'degrees Fahrenheit'),
  k: u('temperature', 1, 'kelvin', 'kelvin'),
};

/** Spoken and written names → unit keys. */
const ALIASES: Record<string, string> = {
  millimeter: 'mm',
  millimetre: 'mm',
  centimeter: 'cm',
  centimetre: 'cm',
  meter: 'm',
  metre: 'm',
  kilometer: 'km',
  kilometre: 'km',
  kms: 'km',
  inch: 'in',
  inches: 'in',
  '"': 'in',
  foot: 'ft',
  feet: 'ft',
  "'": 'ft',
  yard: 'yd',
  mile: 'mi',
  milligram: 'mg',
  gram: 'g',
  gm: 'g',
  kilogram: 'kg',
  kilo: 'kg',
  kgs: 'kg',
  ounce: 'oz',
  pound: 'lb',
  lbs: 'lb',
  stone: 'st',
  ton: 't',
  tonne: 't',
  'metric ton': 't',
  milliliter: 'ml',
  millilitre: 'ml',
  liter: 'l',
  litre: 'l',
  teaspoon: 'tsp',
  tablespoon: 'tbsp',
  'fluid ounce': 'floz',
  'fl oz': 'floz',
  pint: 'pt',
  quart: 'qt',
  gallon: 'gal',
  'kilometer per hour': 'kmh',
  'kilometre per hour': 'kmh',
  'km/h': 'kmh',
  kph: 'kmh',
  'mile per hour': 'mph',
  'meter per second': 'ms',
  'm/s': 'ms',
  knot: 'kn',
  'square meter': 'sqm',
  'square metre': 'sqm',
  m2: 'sqm',
  'square foot': 'sqft',
  'square feet': 'sqft',
  'sq ft': 'sqft',
  hectare: 'ha',
  'square kilometer': 'sqkm',
  'square kilometre': 'sqkm',
  'square mile': 'sqmi',
  kilobyte: 'kb',
  megabyte: 'mb',
  gigabyte: 'gb',
  gig: 'gb',
  terabyte: 'tb',
  second: 'sec',
  s: 'sec',
  minute: 'min',
  hour: 'hr',
  h: 'hr',
  celsius: 'c',
  centigrade: 'c',
  'degree celsius': 'c',
  '°c': 'c',
  fahrenheit: 'f',
  'degree fahrenheit': 'f',
  '°f': 'f',
  kelvin: 'k',
};

/** "Miles", "kilometres", "degrees F", "fl. oz." → a unit key, or null. */
export function findUnit(raw: string): string | null {
  let name = raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/^(?:a|an|one|the) /, '')
    .replace(/^degrees? /, 'degree ')
    .trim();
  if (name === 'degree c') name = 'c';
  if (name === 'degree f') name = 'f';
  // Plurals, word by word: "miles", "inches", "kilometers per hour".
  const words = name.split(' ');
  const variants = [
    name,
    words.map((w) => w.replace(/s$/, '')).join(' '),
    words.map((w) => w.replace(/es$/, '')).join(' '),
  ];
  for (const candidate of variants) {
    if (UNITS[candidate]) return candidate;
    if (ALIASES[candidate]) return ALIASES[candidate];
  }
  return null;
}

function toCelsius(value: number, unit: string): number {
  if (unit === 'f') return ((value - 32) * 5) / 9;
  if (unit === 'k') return value - 273.15;
  return value;
}

function fromCelsius(value: number, unit: string): number {
  if (unit === 'f') return (value * 9) / 5 + 32;
  if (unit === 'k') return value + 273.15;
  return value;
}

/** Rounds to what's worth saying aloud: 3 significant figures, at most 2 decimals for big numbers. */
export function speakNumber(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const rounded = abs >= 100 ? Math.round(value * 10) / 10 : Number(value.toPrecision(3));
  return rounded.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 1 : 4 });
}

export type Conversion = { ok: true; value: number; text: string } | { ok: false; error: string };

export function convert(value: number, fromRaw: string, toRaw: string): Conversion {
  const from = findUnit(fromRaw);
  const to = findUnit(toRaw);
  if (!from) return { ok: false, error: `I don't know the unit “${fromRaw}”.` };
  if (!to) return { ok: false, error: `I don't know the unit “${toRaw}”.` };
  const a = UNITS[from]!;
  const b = UNITS[to]!;
  if (a.kind !== b.kind) return { ok: false, error: `I can't convert ${a.many} to ${b.many}.` };
  const result =
    a.kind === 'temperature'
      ? fromCelsius(toCelsius(value, from), to)
      : (value * a.factor) / b.factor;
  const name = (unit: Unit, n: number) => (Math.abs(n) === 1 ? unit.one : unit.many);
  return {
    ok: true,
    value: result,
    text: `${speakNumber(value)} ${name(a, value)} is ${speakNumber(result)} ${name(b, Number(speakNumber(result).replace(/,/g, '')))}.`,
  };
}

export function unitTools() {
  return [
    defineTool({
      name: 'convert_units',
      description:
        'Convert between units of length, weight, volume (cooking too), speed, area, data size, time or temperature. Exact and offline.',
      risk: 'safe',
      input: z.object({
        value: z.number(),
        from: z.string().min(1).describe('e.g. "miles", "cups", "fahrenheit"'),
        to: z.string().min(1),
      }),
      describe: ({ value, from, to }) => `Convert ${value} ${from} to ${to}`,
      run: async ({ value, from, to }) => {
        const result = convert(value, from, to);
        return result.ok
          ? { ok: true, speak: result.text }
          : { ok: false, speak: result.error, followUp: true };
      },
    }),
  ];
}
