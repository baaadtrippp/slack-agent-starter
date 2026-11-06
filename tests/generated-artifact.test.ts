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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectRunArtifact,
  readRunArtifact,
} from '../apps/gateway/src/generated-artifact.js';

const { sandboxGet } = vi.hoisted(() => ({ sandboxGet: vi.fn() }));
vi.mock('../apps/gateway/node_modules/@vercel/sandbox/dist/index.js', () => ({
  Sandbox: { get: sandboxGet },
}));

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

  function collect(id = runId, format = 'csv') {
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        readRunArtifact,
        '--',
        workspace,
        id,
        format,
      ],
      { timeout: 2_000 },
    );
  }

  it('returns exactly the selected run file bytes', () => {
    writeFileSync(result, csv);
    const read = collect();
    expect(read.status).toBe(0);
    expect(Buffer.from(read.stdout.toString(), 'base64')).toEqual(csv);
  });

  it.each(['diff', 'md'])('collects exact UTF-8 bytes for %s', (format) => {
    const content = Buffer.from('Synthetic artifact.\n');
    writeFileSync(join(results, 'result.' + format), content);
    const read = collect(runId, format);
    expect(read.status).toBe(0);
    expect(Buffer.from(read.stdout.toString(), 'base64')).toEqual(content);
    expect(collect().status).toBe(1);
  });

  it('does not search another run or accept traversal', () => {
    expect(collect().status).toBe(1);
    expect(collect('../' + otherRun).status).toBe(1);
    expect(collect(runId, '../result.csv').status).toBe(1);
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

it.each([
  { status: 'stopped', sessionId: 'test-session' },
  { status: 'running', sessionId: 'other-session' },
])(
  'does not collect from a Sandbox session with $status status and ID $sessionId',
  async (session) => {
    const runCommand = vi.fn();
    sandboxGet.mockResolvedValueOnce({
      currentSession: () => ({ ...session, runCommand }),
    });

    await expect(
      collectRunArtifact(runId, {
        sandboxName: 'test-worker',
        sessionId: 'test-session',
      }),
    ).rejects.toThrow('Artifact Sandbox session is unavailable');
    expect(runCommand).not.toHaveBeenCalled();
  },
);
