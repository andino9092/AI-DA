import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlLog } from '../../../src/main/safety/action-log';
import { tempDir } from '../fakes';

describe('JsonlLog', () => {
  it("keeps logging when the day's file can't be written (held open by another program)", () => {
    const dir = tempDir();
    const log = new JsonlLog(dir, 'actions');
    const day = new Date().toISOString().slice(0, 10);
    // A folder where the file should be makes every write to it fail, like a locked file.
    mkdirSync(join(dir, `actions-${day}.jsonl`));
    log.write({ type: 'panic' });
    const fallback = join(dir, `actions-${day}-2.jsonl`);
    expect(readFileSync(fallback, 'utf8').trim().split('\n')).toHaveLength(1);

    // Once the file is writable again, new lines go back to it.
    rmSync(join(dir, `actions-${day}.jsonl`), { recursive: true });
    log.write({ type: 'panic' });
    expect(
      readFileSync(join(dir, `actions-${day}.jsonl`), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual([`actions-${day}-2.jsonl`, `actions-${day}.jsonl`]);
  });
});
