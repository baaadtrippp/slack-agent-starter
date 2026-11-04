import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunCsv } from '../apps/gateway/src/generated-csv.js';

const runId = '11111111-1111-4111-8111-111111111111';
const otherRun = '22222222-2222-4222-8222-222222222222';
const csv = Buffer.from('label,cents\r\néclair,17\r\n');

describe.skipIf(process.platform !== 'linux')('Sandbox result reader', () => {
  let workspace: string;
  let results: string;
  let result: string;
  let otherResult: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'synthetic-csv-'));
    results = join(workspace, 'runs', runId, 'results');
    result = join(results, 'result.csv');
    const otherResults = join(workspace, 'runs', otherRun, 'results');
    otherResult = join(otherResults, 'result.csv');
    mkdirSync(results, { recursive: true });
    mkdirSync(otherResults, { recursive: true });
    writeFileSync(otherResult, 'synthetic,other-run\n');
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  function collect(id = runId) {
    return spawnSync(
      process.execPath,
      ['--input-type=module', '-e', readRunCsv, '--', workspace, id],
      { timeout: 2_000 },
    );
  }

  it('returns exactly the selected run file bytes', () => {
    writeFileSync(result, csv);
    const read = collect();
    expect(read.status).toBe(0);
    expect(Buffer.from(read.stdout.toString(), 'base64')).toEqual(csv);
  });

  it('does not search another run or accept traversal', () => {
    expect(collect().status).toBe(1);
    expect(collect('../' + otherRun).status).toBe(1);
  });

  it.each([
    'symbolic link',
    'linked directory',
    'hard link',
    'directory',
    'oversized',
  ])('rejects %s output without returning its bytes', (kind) => {
    if (kind === 'symbolic link') symlinkSync(otherResult, result);
    if (kind === 'linked directory') {
      rmdirSync(results);
      symlinkSync(join(workspace, 'runs', otherRun, 'results'), results);
    }
    if (kind === 'hard link') linkSync(otherResult, result);
    if (kind === 'directory') mkdirSync(result);
    if (kind === 'oversized')
      writeFileSync(result, Buffer.alloc(16 * 1024 + 1));
    const read = collect();
    expect(read.status).toBe(1);
    expect(read.stdout.length).toBe(0);
  });
});
