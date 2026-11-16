import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The bootstrap helper has no declaration file.
import * as workerEgress from '../apps/gateway/scripts/worker-egress.mjs';

const { SetupError, workerAllow } = workerEgress;

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

describe('worker egress', () => {
  const gateway = 'gateway.example.com';
  const openrouter = [
    { transform: [{ headers: { Authorization: 'Bearer sk-or-v1-0a' } }] },
  ];
  const allow = (toolApis: unknown[], read = vi.fn(() => 'example-value')) =>
    workerAllow(gateway, 'sk-or-v1-0a', toolApis, read);

  it('allows only the gateway and OpenRouter without tool APIs', () => {
    const result = allow([]);
    expect(result).toEqual({ [gateway]: [], 'openrouter.ai': openrouter });
    // The egress check expects exactly these hosts.
    expect(Object.keys(result)).toEqual([gateway, 'openrouter.ai']);
  });

  it('adds tool API hosts and reads only a named key', () => {
    const read = vi.fn(() => 'example-value');
    const result = allow(
      [
        {
          host: 'api.example.com',
          header: 'X-Api-Key',
          key: 'EXAMPLE_API_KEY',
        },
        { host: 'data.example.org' },
      ],
      read,
    );
    expect(result).toEqual({
      [gateway]: [],
      'openrouter.ai': openrouter,
      'api.example.com': [
        { transform: [{ headers: { 'X-Api-Key': 'example-value' } }] },
      ],
      'data.example.org': [],
    });
    expect(Object.keys(result)).toHaveLength(4);
    expect(read.mock.calls).toEqual([['EXAMPLE_API_KEY']]);
  });

  it.each([
    { host: 'openrouter.ai' },
    { host: gateway },
    { host: 'API.example.com' },
    { host: 'https://api.example.com' },
    { host: 'api.example.com:8443' },
    { host: 'api.example.com/v1' },
    { host: '*.example.com' },
    { host: '203.0.113.7' },
    { host: 'localhost' },
    { host: 'api.example.com', header: 'X-Api-Key' },
    { host: 'api.example.com', key: 'EXAMPLE_API_KEY' },
    { host: 'api.example.com', header: 'X Api Key', key: 'EXAMPLE_API_KEY' },
    { host: 'api.example.com', header: 'X-Api-Key', key: 'example-key' },
    { host: 'api.example.com', headers: { 'X-Api-Key': 'EXAMPLE_API_KEY' } },
  ])('refuses %j', (entry) => {
    expect(() => allow([entry])).toThrow(SetupError);
  });

  it('refuses a repeated host', () => {
    const entry = { host: 'api.example.com' };
    expect(() => allow([entry, entry])).toThrow('Invalid toolApis entry');
  });
});
