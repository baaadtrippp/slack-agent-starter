import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
// @ts-expect-error The copied Sandbox script has no declaration file.
import { controlRun } from '../apps/worker/sandbox/control.mjs';
// @ts-expect-error The copied Sandbox script has no declaration file.
import * as workerRun from '../apps/worker/sandbox/run.mjs';
// @ts-expect-error The copied Sandbox script has no declaration file.
import * as workerSupervisor from '../apps/worker/sandbox/supervise.mjs';

const { supervise, verifyGroupMembership } = workerSupervisor;

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

function paddedJson(value: object, size: number) {
  const empty = JSON.stringify({ ...value, padding: '' });
  return JSON.stringify({
    ...value,
    padding: 'x'.repeat(size - Buffer.byteLength(empty)),
  });
}

describe('Sandbox worker control', () => {
  test('keeps cooperative cancellation active through rollback', async () => {
    const source = await readFile(
      join(import.meta.dirname, '../apps/worker/sandbox/run.mjs'),
      'utf8',
    );
    expect(source).toContain("process.on('SIGTERM', cancel)");
    expect(source).not.toContain("process.once('SIGTERM', cancel)");
  });

  test('accepts only exact marked process-group membership', () => {
    const runId = randomUUID();
    const record = { pid: 11, pgid: 11, sessionId: 11 };
    const marker = `A=1\0HYDRA_RUN_ID=${runId}\0B=2\0`;
    const leader = {
      pid: 11,
      pgid: 11,
      sessionId: 11,
      environment: marker,
    };

    expect(() =>
      verifyGroupMembership(record, runId, [
        leader,
        { pid: 12, pgid: 11, sessionId: 11, environment: marker },
        {
          pid: 21,
          pgid: 21,
          sessionId: 21,
          environment: 'HYDRA_RUN_ID=peer\0',
        },
      ]),
    ).not.toThrow();

    expect(() =>
      verifyGroupMembership(record, runId, [
        {
          ...leader,
          environment: `HYDRA_RUN_ID=${runId}-prefix\0`,
        },
      ]),
    ).toThrow('unmarked process');

    expect(() =>
      verifyGroupMembership(record, runId, [
        leader,
        { pid: 12, pgid: 11, sessionId: 11, environment: 'A=1\0' },
      ]),
    ).toThrow('unmarked process');

    expect(() =>
      verifyGroupMembership(record, runId, [
        leader,
        { pid: 21, pgid: 21, sessionId: 21, environment: marker },
      ]),
    ).toThrow('escaped its isolated group');

    expect(() =>
      verifyGroupMembership(record, runId, [
        leader,
        {
          pid: 22,
          pgid: 22,
          sessionId: 11,
          environment: 'A=1\0',
        },
      ]),
    ).toThrow('escaped its isolated group');
  });

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

  test('recovers a failed resumed result from a restored session', async () => {
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
        sessionSafe: 'restored',
        resultType: 'failed',
      }),
    );
    await expect(controlRun(request(runId, 'status'), paths)).resolves.toEqual(
      expect.objectContaining({ result }),
    );
    await rm(paths.root, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== 'linux').each([
    ['interrupted', false],
    ['completed', true],
  ])(
    'refuses to report %s memory save with an inconsistent session as safe',
    async (_outcome, completed) => {
      const paths = await fixture();
      const runId = randomUUID();
      const seedRunId = randomUUID();
      const nativeId = randomUUID();
      const worker = join(paths.root, 'interrupted-memory-worker.mjs');
      const sessions = join(paths.workspace, 'runs', seedRunId, 'pi-sessions');
      await mkdir(join(paths.workspace, 'runs', runId));
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, 'session.jsonl'),
        JSON.stringify({ type: 'session', id: nativeId }) + '\n',
      );
      if (completed)
        await writeFile(
          join(paths.workspace, 'runs', runId, 'result.json'),
          JSON.stringify({
            version: 1,
            runId,
            generation: 1,
            type: 'completed',
          }),
        );
      await writeFile(worker, 'process.exit(0)');
      try {
        await expect(
          supervise(
            {
              version: 1,
              runId,
              generation: 1,
              memory: 'save',
              session: {
                seedRunId,
                nativeId,
                adapterId: randomUUID(),
                revision: 2,
              },
            },
            {
              ...paths,
              worker,
              readIdentity: async () => {
                await delay(200);
                return '1';
              },
            },
          ),
        ).rejects.toThrow('Native session was not restored');
      } finally {
        await rm(paths.root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'registers the exact control before releasing worker admission',
    async () => {
      const paths = await fixture();
      const worker = join(paths.root, 'ready-worker.mjs');
      await writeFile(
        worker,
        `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

process.once('message', async (message) => {
  assert.equal(message.type, 'ready');
  const path = join(process.env.HYDRA_TEST_CONTROLS, message.runId + '.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(record.runId, process.env.HYDRA_RUN_ID);
  assert.equal(record.runId, message.runId);
  assert.equal(record.generation, message.generation);
  process.disconnect();
});
`,
      );
      const runId = randomUUID();
      process.env.HYDRA_TEST_CONTROLS = paths.controls;
      const supervised = supervise(
        { version: 1, runId, generation: 1 },
        { ...paths, worker },
      );
      delete process.env.HYDRA_TEST_CONTROLS;
      await expect(supervised).resolves.toEqual(
        expect.objectContaining({ exitCode: 0, processesExited: true }),
      );
      await rm(paths.root, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'deduplicates cancellation and proves its marked child exited',
    async () => {
      const paths = await fixture();
      const worker = join(paths.root, 'held-worker.mjs');
      await writeFile(
        worker,
        "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
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
      const exit = await supervised;
      expect(exit).toEqual(
        expect.objectContaining({ stopRequested: true, processesExited: true }),
      );
      await expect(
        Promise.all([
          stat(join(paths.controls, runId + '.json')),
          stat(join(paths.controls, runId + '.stop.json')),
          stat(join(paths.workspace, 'runs', runId, 'exit.json')),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ nlink: 1 }),
        expect.objectContaining({ nlink: 1 }),
        expect.objectContaining({ nlink: 1 }),
      ]);
      expect(
        (await readdir(paths.controls)).some((name) => name.endsWith('.tmp')),
      ).toBe(false);
      await rm(paths.root, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'proves exit when Stop interrupts the ready handshake',
    async () => {
      const paths = await fixture();
      const worker = join(paths.root, 'held-before-ready.mjs');
      await writeFile(
        worker,
        "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
      );
      const runId = randomUUID();
      const readyStarted = Promise.withResolvers<void>();
      const supervised = supervise(
        { version: 1, runId, generation: 1 },
        {
          ...paths,
          worker,
          ready: async () => {
            readyStarted.resolve();
            await delay(50);
            throw Object.assign(new Error('Synthetic IPC failure'), {
              code: 'EPIPE',
            });
          },
        },
      );
      await readyStarted.promise;
      const stopped = await controlRun(request(runId, 'cancel'), paths);
      expect(stopped).toEqual(
        expect.objectContaining({
          state: 'exited',
          stopRequested: true,
          processesExited: true,
        }),
      );
      await expect(supervised).resolves.toEqual(
        expect.objectContaining({ state: 'exited', stopRequested: true }),
      );
      await rm(paths.root, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'records a known exit after a ready failure without Stop',
    async () => {
      const paths = await fixture();
      const worker = join(paths.root, 'exited-before-ready.mjs');
      await writeFile(worker, 'setTimeout(()=>process.exit(0),20)');
      const runId = randomUUID();
      const supervised = supervise(
        { version: 1, runId, generation: 1 },
        {
          ...paths,
          worker,
          ready: async () => {
            await delay(50);
            throw Object.assign(new Error('Synthetic IPC failure'), {
              code: 'EPIPE',
            });
          },
        },
      );
      await expect(supervised).resolves.toEqual(
        expect.objectContaining({
          state: 'exited',
          stopRequested: false,
          processesExited: true,
          sessionSafe: 'committed',
        }),
      );
      expect(await controlRun(request(runId, 'status'), paths)).toEqual(
        expect.objectContaining({
          state: 'exited',
          stopRequested: false,
        }),
      );
      await rm(paths.root, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'proves a bounded result when the child exits before identity capture',
    async () => {
      const paths = await fixture();
      const runId = randomUUID();
      const run = join(paths.workspace, 'runs', runId);
      const worker = join(paths.root, 'immediate-worker.mjs');
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
      await writeFile(join(run, 'result.json'), paddedJson(result, 32 * 1024));
      await writeFile(worker, 'process.exit(0)');
      await expect(
        supervise(
          { version: 1, runId, generation: 1 },
          {
            ...paths,
            worker,
            readIdentity: async () => {
              await delay(200);
              return '1';
            },
          },
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          processesExited: true,
          resultType: 'completed',
          sessionSafe: 'committed',
        }),
      );
      await expect(
        controlRun(request(runId, 'status'), paths),
      ).resolves.toEqual(
        expect.objectContaining({
          state: 'exited',
          result: expect.objectContaining(result),
        }),
      );
      await writeFile(
        join(run, 'result.json'),
        paddedJson(result, 32 * 1024 + 1),
      );
      await expect(controlRun(request(runId, 'status'), paths)).rejects.toThrow(
        'Invalid worker record',
      );
      await rm(paths.root, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'waits briefly for a marked descendant to finish',
    async () => {
      const paths = await fixture();
      const runId = randomUUID();
      const worker = join(paths.root, 'draining-worker.mjs');
      await writeFile(
        worker,
        `
import { spawn } from 'node:child_process';

process.once('message', () => {
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  }).unref();
  process.disconnect();
});
`,
      );
      await expect(
        supervise(
          { version: 1, runId, generation: 1 },
          { ...paths, worker, descendantGraceMs: 500 },
        ),
      ).resolves.toEqual(
        expect.objectContaining({ processesExited: true, exitCode: 0 }),
      );
      await rm(paths.root, { recursive: true, force: true });
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'forces only a registered stuck process group',
    async () => {
      const paths = await fixture();
      const runId = randomUUID();
      const worker = join(paths.root, 'stuck-worker.mjs');
      const ready = join(paths.root, 'signal-handler-ready');
      await writeFile(
        worker,
        `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
process.on('message', () => process.disconnect());
writeFileSync(${JSON.stringify(ready)}, '1');
setInterval(() => {}, 1000);
`,
      );
      const supervised = supervise(
        { version: 1, runId, generation: 1 },
        {
          ...paths,
          worker,
          cooperativeGraceMs: 100,
          proveGroup: () => {},
        },
      );
      try {
        let status;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          status = await controlRun(request(runId, 'status'), paths);
          // The supervisor registers the group before the child handles signals.
          if (
            status.state === 'running' &&
            (await readFile(ready, 'utf8').catch(() => undefined)) === '1'
          )
            break;
          await delay(20);
        }
        expect(status?.state).toBe('running');
        expect(await readFile(ready, 'utf8')).toBe('1');
        await expect(
          controlRun(request(runId, 'cancel'), paths),
        ).resolves.toEqual(
          expect.objectContaining({
            state: 'exited',
            forced: true,
            targetPgid: expect.any(Number),
            processesExited: true,
            sessionSafe: 'uncommitted',
          }),
        );
        await expect(supervised).resolves.toEqual(
          expect.objectContaining({ forced: true, stopRequested: true }),
        );
      } finally {
        await controlRun(request(runId, 'cancel'), paths).catch(() => {});
        await supervised.catch(() => {});
        await rm(paths.root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform !== 'linux')(
    'restores exact checkpoint bytes after a forced resumed Stop',
    async () => {
      const paths = await fixture();
      const runId = randomUUID();
      const seedRunId = randomUUID();
      const nativeId = randomUUID();
      const adapterId = randomUUID();
      const seed = join(paths.workspace, 'runs', seedRunId);
      const sessions = join(seed, 'pi-sessions');
      const adapter = join(seed, 'pi-acp');
      const transcript = join(sessions, 'session.jsonl');
      const mutated = join(paths.root, 'mutated');
      const scratch = join('/tmp/hydra-worker-state', seedRunId);
      const source = Buffer.from(
        JSON.stringify({ type: 'session', id: nativeId }) + '\n',
      );
      const job = {
        version: 1,
        runId,
        generation: 1,
        input: {},
        session: {
          seedRunId,
          nativeId,
          adapterId,
          revision: 1,
        },
      };
      await mkdir(sessions, { recursive: true });
      await mkdir(adapter);
      await mkdir(scratch, { recursive: true });
      await writeFile(transcript, source);
      await writeFile(
        join(seed, 'result.json'),
        JSON.stringify({
          version: 1,
          runId: seedRunId,
          generation: 1,
          eventId: randomUUID(),
          sequence: 2,
          type: 'completed',
          text: 'Seed',
          session: job.session,
        }),
      );
      await writeFile(
        join(adapter, 'session-map.json'),
        JSON.stringify({
          sessions: {
            [adapterId]: {
              sessionId: adapterId,
              cwd: join(seed, 'work'),
              sessionFile: join(scratch, 'agent', 'sessions', 'session.jsonl'),
            },
          },
        }),
      );
      const before = {
        file: 'session.jsonl',
        nativeId,
        adapterId,
        records: [{ type: 'session', id: nativeId }],
        source: source.toString('utf8'),
        sourceBytes: source,
      };
      await workerRun.writeRollbackOwner(scratch, job);
      await workerRun.writeRollbackCheckpoint(scratch, job, before);
      const worker = join(paths.root, 'mutating-stuck-worker.mjs');
      await writeFile(
        worker,
        `
import { writeFile } from 'node:fs/promises';
process.on('SIGTERM', () => {});
process.on('message', async () => {
  await writeFile(process.env.HYDRA_TEST_TRANSCRIPT, process.env.HYDRA_TEST_MUTATION);
  await writeFile(process.env.HYDRA_TEST_MUTATED, '1');
  process.disconnect();
});
setInterval(() => {}, 1000);
`,
      );
      process.env.HYDRA_TEST_TRANSCRIPT = transcript;
      process.env.HYDRA_TEST_MUTATION =
        JSON.stringify({ type: 'session', id: nativeId, changed: true }) + '\n';
      process.env.HYDRA_TEST_MUTATED = mutated;
      const supervised = supervise(job, {
        ...paths,
        worker,
        cooperativeGraceMs: 100,
        proveGroup: () => {},
      });
      delete process.env.HYDRA_TEST_TRANSCRIPT;
      delete process.env.HYDRA_TEST_MUTATION;
      delete process.env.HYDRA_TEST_MUTATED;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await readFile(mutated).catch(() => undefined)) break;
        await delay(20);
      }
      await expect(
        controlRun(request(runId, 'cancel'), paths),
      ).resolves.toEqual(
        expect.objectContaining({ forced: true, sessionSafe: 'restored' }),
      );
      await expect(supervised).resolves.toEqual(
        expect.objectContaining({ forced: true, sessionSafe: 'restored' }),
      );
      await expect(readFile(transcript)).resolves.toEqual(source);
      await expect(readFile(scratch)).rejects.toThrow();
      await rm(paths.root, { recursive: true, force: true });
    },
  );
});
