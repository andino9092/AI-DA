import { z } from 'zod';
import { defineTool } from '../types';

export function timeTools(now: () => Date = () => new Date()) {
  return [
    defineTool({
      name: 'get_time',
      description: 'Get the current local date and time.',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'Check the time',
      run: async () => {
        const date = now();
        const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const day = date.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        });
        return { ok: true, speak: `It's ${time}.`, data: { time, day } };
      },
    }),
  ];
}
