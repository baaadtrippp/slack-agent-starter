import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The bootstrap runs on import, so these checks read its source.
const root = join(import.meta.dirname, '..');
const source = await readFile(
  join(root, 'apps/gateway/scripts/bootstrap-worker.mjs'),
  'utf8',
);
const list = (name: string) =>
  [
    ...new RegExp(`const ${name} = \\[([^\\]]*)\\]`)
      .exec(source)![1]!
      .matchAll(/'([^']+)'/g),
  ].map(([, value]) => value);

describe('worker bootstrap', () => {
  it('copies every worker file and syntax-checks only the scripts', async () => {
    expect(list('files').toSorted()).toEqual(
      (await readdir(join(root, 'apps/worker/sandbox'))).toSorted(),
    );
    expect(source).toContain(
      "...files\n        .filter((name) => name.endsWith('.mjs'))\n        .map((name) => 'node --check ' + name),",
    );
  });

  it('denies non-public IPv4 ranges from the worker', () => {
    expect(list('deny')).toEqual([
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ]);
  });
});
