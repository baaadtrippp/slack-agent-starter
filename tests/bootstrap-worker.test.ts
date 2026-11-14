import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  it('copies every tracked worker file', () => {
    const tracked = execFileSync('git', ['ls-files', 'apps/worker/sandbox'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(list('files').toSorted()).toEqual(
      tracked
        .trim()
        .split('\n')
        .map((path) => basename(path))
        .toSorted(),
    );
  });

  it('lists the IPv4 ranges the worker egress denies', () => {
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
