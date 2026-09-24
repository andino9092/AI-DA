import { useState } from 'react';
import type { Settings, SettingsPatch } from '@shared/settings';
import { Button, Section } from './components';

const INPUT =
  'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950';

export function WeatherSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: SettingsPatch) => void;
}) {
  const { place, unit } = settings.weather;
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    const result = await window.aida.weather.findPlace(city.trim());
    setBusy(false);
    if (result.ok) {
      setCity('');
      setError(null);
    } else setError(result.error);
  }

  return (
    <Section
      title="Weather"
      description="“What's the weather?” uses this city. Only the city is sent to Open-Meteo (free, no account); your location is never looked up from your connection."
    >
      <div className="text-sm">
        {place ? (
          <>
            Home city: <span className="font-medium">{place.name}</span>
          </>
        ) : (
          <span className="text-zinc-500 dark:text-zinc-400">No home city set yet.</span>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="City, e.g. Toronto or Springfield, Illinois"
          aria-label="Home city"
          maxLength={100}
          disabled={busy}
          className={INPUT}
        />
        <Button type="submit" variant="primary" disabled={busy || city.trim() === ''}>
          {busy ? 'Finding…' : place ? 'Change' : 'Set city'}
        </Button>
        {place && (
          <Button onClick={() => update({ weather: { ...settings.weather, place: null } })}>
            Clear
          </Button>
        )}
      </form>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm">Temperature</div>
        <select
          value={unit}
          onChange={(e) =>
            update({ weather: { ...settings.weather, unit: e.target.value as typeof unit } })
          }
          aria-label="Temperature unit"
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="auto">Automatic (Windows region)</option>
          <option value="celsius">Celsius</option>
          <option value="fahrenheit">Fahrenheit</option>
        </select>
      </div>
    </Section>
  );
}
