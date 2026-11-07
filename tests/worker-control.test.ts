import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
// @ts-expect-error The copied Sandbox script has no declaration file.
import { controlRun } from '../apps/worker/sandbox/control.mjs';
// @ts-expect-error The copied Sandbox script has no declaration file.
import { supervise } from '../apps/worker/sandbox/supervise.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hydra-control-'));
  const controls = join(root, 'controls');
  const workspace = join(root, 'workspace');
  await mkdir(controls);
  await mkdir(join(workspace, 'runs'), { recursive: true });
  return { root, controls, workspace };
}

function request(runId: string, action: 'status' | 'cancel', generation = 1) {
  return { version: 1, runId, generation, action };
}

describe('Sandbox worker control', () => {
  test('recovers only a normal committed result', async () => {
    const paths = await fixture();
    const runId = randomUUID();
    const run = join(paths.workspace, 'runs', runId);
    const result = {
      version: 1,
      runId,
      generation: 1,
      eventId: randomUUID(),
      sequence: 2,
      type: 'completed',
      text: 'Synthetic answer',
    };
    await mkdir(run);
    await writeFile(join(run, 'result.json'), JSON.stringify(result));
    await writeFile(
      join(run, 'exit.json'),
      JSON.stringify({
        version: 1,
        runId,
        generation: 1,
        state: 'exited',
        stopRequested: false,
        forced: false,
        processesExited: true,
        sessionSafe: 'committed',
      }),
    );
    await expect(controlRun(request(runId, 'status'), paths)).resolves.toEqual(
      expect.objectContaining({ state: 'exited', result }),
    );
    await expect(
      controlRun(request(runId, 'status', 2), paths),
    ).rejects.toThrow('Invalid worker exit proof');
    await rm(paths.root, { recursive: true, force: true });
  });

  test('recovers a result after exact environment stop proof', async () => {
    const paths = await fixture();
    const runId = randomUUID();
    const run = join(paths.workspace, 'runs', runId);
    const result = {
      version: 1,
      runId,
      generation: 1,
      eventId: randomUUID(),
      sequence: 2,
      type: 'failed',
      text: 'Synthetic failure',
    };
    await mkdir(run);
    await writeFile(join(run, 'result.json'), JSON.stringify(result));
    await expect(
      controlRun(
        {
          ...request(runId, 'status'),
          environmentStopped: true,
        },
        paths,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        state: 'exited',
        processesExited: true,
        sessionSafe: 'committed',
        result,
      }),
    );
    await rm(paths.root, { recursive: true, force: true });
  });

  test('returns a committed result when Stop raced its manifest', async () => {
    const paths = await fixture();
    const runId = randomUUID();
    const run = join(paths.workspace, 'runs', runId);
    const result = {
      version: 1,
      runId,
      generation: 1,
      eventId: randomUUID(),
      sequence: 2,
      type: 'completed',
      text: 'Suppressed committed answer',
    };
    await mkdir(run);
    await writeFile(join(run, 'result.json'), JSON.stringify(result));
    await writeFile(
      join(run, 'exit.json'),
      JSON.stringify({
        version: 1,
        runId,
        generation: 1,
        state: 'exited',
        stopRequested: false,
        forced: false,
        processesExited: true,
        sessionSafe: 'committed',
        resultType: 'completed',
      }),
    );
    await writeFile(
      join(paths.controls, runId + '.json'),
      JSON.stringify({
        version: 1,
        runId,
        generation: 1,
        controlId: randomUUID(),
        pid: 999_999,
        startTicks: '1',
      }),
    );
    await expect(controlRun(request(runId, 'cancel'), paths)).resolves.toEqual(
      expect.objectContaining({ stopRequested: true, result }),
    );
    await rm(paths.root, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== 'linux')(
    'deduplicates cancellation and proves its marked child exited',
    async () => {
      const paths = await fixture();
      const worker = join(paths.root, 'held-worker.mjs');
      const quote = String.fromCharCode(39);
      await writeFile(
        worker,
        [
          'process.once(',
          quote,
          'SIGTERM',
          quote,
          ',()=>process.exit(0));setInterval(()=>{},1000)',
        ].join(''),
      );
      const runId = randomUUID();
      const supervised = supervise(
        { version: 1, runId, generation: 1 },
        { ...paths, worker },
      );
      let status;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        status = await controlRun(request(runId, 'status'), paths);
        if (status.state === 'running') break;
        await delay(20);
      }
      expect(status?.state).toBe('running');
      const stopped = await Promise.all([
        controlRun(request(runId, 'cancel'), paths),
        controlRun(request(runId, 'cancel'), paths),
      ]);
      expect(stopped).toEqual([
        expect.objectContaining({
          state: 'exited',
          sessionSafe: 'uncommitted',
        }),
        expect.objectContaining({
          state: 'exited',
          sessionSafe: 'uncommitted',
        }),
      ]);
      await expect(supervised).resolves.toEqual(
        expect.objectContaining({ stopRequested: true, processesExited: true }),
      );
      await rm(paths.root, { recursive: true, force: true });
    },
  );
});
