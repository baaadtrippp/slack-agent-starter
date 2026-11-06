import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StagedSource } from '../packages/contracts/src/index.js';

// The deployed Sandbox entry point is standalone JavaScript.
// @ts-expect-error The Sandbox entry point has no declaration file.
import * as sandboxWorker from '../apps/worker/sandbox/run.mjs';

const {
  loadRetainedInputs,
  prepareSources,
  removeRejectedCurrentInputs,
  writeArtifactExtension,
  writeRevisionCatalog,
} = sandboxWorker;

describe.skipIf(process.platform !== 'linux')('scoped worker inputs', () => {
  let workspace: string;
  let seed: string;
  let run: string;
  let session: string;
  const csv = Buffer.from('period,amount\nQ1,12\n');
  const methodology = Buffer.from('Use the sum of amounts.\n');

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'synthetic-file-exchange-'));
    seed = randomUUID();
    run = randomUUID();
    session = join(workspace, 'runs', seed);
    await mkdir(join(session, 'input-revisions'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function stage(
    bytes: Buffer,
    kind: StagedSource['kind'],
    name: string,
    index: number,
  ) {
    const directory = join(workspace, 'inputs', seed, run);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'input-' + index);
    await writeFile(path, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { source: { kind, name, sha256, runId: run, index }, path };
  }

  it('reopens exact CSV and URL bytes from the saved revision only', async () => {
    const { source: first } = await stage(csv, 'csv', 'revenue.csv', 0);
    const { source: second } = await stage(
      methodology,
      'publicUrl',
      'Public URL text',
      1,
    );
    const original = await prepareSources(
      [first, second],
      seed,
      { runId: run },
      workspace,
      workspace,
    );
    expect(original.required).toEqual(['input-1', 'input-2']);
    expect(original.attachments).toEqual([]);
    const revisions = join(session, 'input-revisions');
    await writeFile(join(revisions, '7.json'), JSON.stringify([first, second]));
    await writeFile(join(revisions, '8.json'), JSON.stringify([second]));
    expect(await loadRetainedInputs(session, 6)).toEqual([]);

    const selected = await loadRetainedInputs(session, 7);
    const followup = await prepareSources(
      selected,
      seed,
      { runId: randomUUID() },
      workspace,
      workspace,
    );
    expect(followup.required).toEqual([]);
    expect(followup.inputs).toEqual({
      'input-1': { type: 'text', text: csv.toString() },
      'input-2': { type: 'text', text: methodology.toString() },
    });
    expect(followup.catalog).toEqual([
      { id: 'input-1', kind: 'csv', name: 'revenue.csv', current: false },
      {
        id: 'input-2',
        kind: 'publicUrl',
        name: 'Public URL text',
        current: false,
      },
    ]);
    await expect(
      prepareSources(
        selected,
        randomUUID(),
        { runId: randomUUID() },
        workspace,
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal in a retained catalog before resolving any input path', async () => {
    const { source } = await stage(csv, 'csv', 'revenue.csv', 0);
    const revision = join(session, 'input-revisions', '7.json');
    await writeFile(
      revision,
      JSON.stringify([{ ...source, runId: '../other-run' }]),
    );
    await expect(loadRetainedInputs(session, 7)).rejects.toThrow(
      'Invalid retained input catalog',
    );
  });

  it('rejects tampered bytes and symbolic links', async () => {
    const { path, source } = await stage(csv, 'csv', 'revenue.csv', 0);
    await writeFile(path, Buffer.from(csv).fill('A'));
    await expect(
      prepareSources([source], seed, { runId: run }, workspace, workspace),
    ).rejects.toThrow('Staged input checksum mismatch');
    const other = join(workspace, 'other-conversation.csv');
    await writeFile(other, csv);
    await rm(path);
    await symlink(other, path);
    await expect(
      prepareSources([source], seed, { runId: run }, workspace, workspace),
    ).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('passes verified JPEG bytes as a native attachment and makes them available on reuse', async () => {
    // Gateway MIME and structure validation has its own JPEG tests.
    const bytes = Buffer.from(
      'ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9',
      'hex',
    );
    const { source } = await stage(bytes, 'jpeg', 'sample.jpg', 0);
    const first = await prepareSources(
      [source],
      seed,
      { runId: run },
      workspace,
      workspace,
    );
    const data = bytes.toString('base64');
    expect(first.attachments).toEqual([{ mediaType: 'image/jpeg', data }]);
    const resumed = await prepareSources(
      [source],
      seed,
      { runId: randomUUID() },
      workspace,
      workspace,
    );
    expect(resumed.attachments).toEqual([]);
    expect(resumed.inputs['input-1']).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data,
    });
  });

  it('allows an artifact write retry after file creation fails', async () => {
    const extension = join(workspace, 'write-artifact.mjs');
    await writeFile(
      extension,
      writeArtifactExtension.replace(
        "import { Type } from 'typebox';",
        'const Type = { String: (value) => value, Object: (value) => value, Unsafe: (value) => value };',
      ),
    );
    const results = join(workspace, 'results');
    const previousResults = process.env.HYDRA_RESULTS;
    const previousArtifactOutput = process.env.HYDRA_ARTIFACT_OUTPUT;
    process.env.HYDRA_RESULTS = results;
    process.env.HYDRA_ARTIFACT_OUTPUT = '1';
    let tool:
      | {
          execute(
            id: string,
            args: { format: string; content: string },
          ): Promise<unknown>;
        }
      | undefined;
    try {
      const register = (await import(pathToFileURL(extension).href)).default;
      register({
        registerTool(value: typeof tool) {
          tool = value;
        },
      });
      const args = { format: 'csv', content: 'period,total\nQ1,18\n' };
      await expect(tool!.execute('first', args)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await mkdir(results);
      await expect(tool!.execute('retry', args)).resolves.toMatchObject({
        content: [{ type: 'text', text: 'Saved result.csv.' }],
        details: { format: 'csv' },
      });
      expect(await readFile(join(results, 'result.csv'), 'utf8')).toBe(
        args.content,
      );
    } finally {
      if (previousResults === undefined) delete process.env.HYDRA_RESULTS;
      else process.env.HYDRA_RESULTS = previousResults;
      if (previousArtifactOutput === undefined)
        delete process.env.HYDRA_ARTIFACT_OUTPUT;
      else process.env.HYDRA_ARTIFACT_OUTPUT = previousArtifactOutput;
    }
  });

  it('removes only rejected current-run staged inputs', async () => {
    const current = join(workspace, 'inputs', seed, run);
    const retainedRun = randomUUID();
    const retained = join(workspace, 'inputs', seed, retainedRun);
    await mkdir(current, { recursive: true });
    await mkdir(retained, { recursive: true });
    await writeFile(join(current, 'input-0'), csv);
    await writeFile(join(current, 'input-1'), methodology);
    await writeFile(join(current, 'keep.txt'), 'preexisting');
    await writeFile(join(retained, 'input-0'), 'retained');

    await removeRejectedCurrentInputs(
      seed,
      run,
      [{ index: 0 }, { index: 1 }],
      workspace,
    );

    await expect(readFile(join(current, 'input-0'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(current, 'input-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(current, 'keep.txt'), 'utf8')).toBe(
      'preexisting',
    );
    expect(await readFile(join(retained, 'input-0'), 'utf8')).toBe('retained');

    await rm(current, { recursive: true });
    await symlink(retained, current, 'dir');
    await expect(
      removeRejectedCurrentInputs(seed, run, [{ index: 0 }], workspace),
    ).rejects.toThrow();
    expect(await readFile(join(retained, 'input-0'), 'utf8')).toBe('retained');
  });

  it('atomically commits revision catalogs without replacing existing files', async () => {
    const revisions = join(session, 'input-revisions');
    const { source } = await stage(csv, 'csv', 'revenue.csv', 0);
    await expect(
      writeRevisionCatalog(revisions, 7, [
        {
          toJSON() {
            throw new Error('synthetic serialization failure');
          },
        },
      ]),
    ).rejects.toThrow('synthetic serialization failure');
    await expect(readFile(join(revisions, '7.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeRevisionCatalog(revisions, 7, [source]);
    const committed = await readFile(join(revisions, '7.json'), 'utf8');
    expect(JSON.parse(committed)).toEqual([source]);

    await expect(writeRevisionCatalog(revisions, 7, [])).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(join(revisions, '7.json'), 'utf8')).toBe(committed);
  });
});
