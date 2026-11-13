import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Evals (D-010): the real assistant and a real model on a simulated PC. Kept out of `npm test`
 * because they need API keys and spend free-tier quota. Run with `npm run eval`.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['evals/**/*.eval.ts'],
    environment: 'node',
    // Free tiers allow a few requests a minute, so a full run takes a while.
    testTimeout: 3 * 60 * 60_000,
    hookTimeout: 60_000,
  },
});
