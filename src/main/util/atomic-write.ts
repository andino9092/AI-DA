import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write to a temp file, then rename over the target so a crash never leaves a half-written file. */
export function writeFileAtomic(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, filePath);
}
