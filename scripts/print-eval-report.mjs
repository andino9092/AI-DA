// Prints the newest eval scorecard (evals/reports/*.md) after `npm run eval`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'reports');
const newest = readdirSync(dir)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .at(-1);
if (!newest) {
  console.error('No eval report found.');
  process.exit(1);
}
console.log(`\n${readFileSync(join(dir, newest), 'utf8')}`);
console.log(`Saved as evals/reports/${newest} (the .json next to it has every run).`);
