import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createManagedWorker } from '../apps/gateway/src/managed-worker.js';
import { RedisRunStore } from '../apps/gateway/src/store.js';
import type { RunRecord } from '../apps/gateway/src/store.js';
import type { WorkerJob } from '../packages/contracts/src/index.js';

const { sandboxGet, driveGet } = vi.hoisted(() => ({
  sandboxGet: vi.fn(),
  driveGet: vi.fn(),
}));
vi.mock('../apps/gateway/node_modules/@vercel/sandbox/dist/index.js', () => ({
  Sandbox: { get: sandboxGet },
  Drive: { get: driveGet },
}));

const redisUrl = process.env.TEST_REDIS_URL;
const namespace = `managed-worker-test:${randomUUID()}`;

describe.skipIf(!redisUrl)('managed worker replacement', () => {
  const state = createRedisState({
    url: redisUrl ?? 'redis://127.0.0.1:1',
    keyPrefix: namespace,
  });
  beforeAll(() => state.connect());
  afterAll(async () => {
    const client = state.getClient();
    for await (const keys of client.scanIterator({ MATCH: `${namespace}:*` }))
      if (keys.length) await client.del(keys);
    await state.disconnect();
  });

  it('waits for detachment and reconciles a lost resume response without resuming again', async () => {
    const store = new RedisRunStore(state.getClient(), namespace);
    const sandboxName = 'synthetic-worker';
    const driveName = 'synthetic-drive';
    const seedId = 'synthetic-seed';
    const driveId = 'synthetic-drive-id';
    const oldId = 'synthetic-old-session';
    const replacementId = 'synthetic-replacement-session';
    const old = {
      sessionId: oldId,
      status: 'stopped',
      sourceSnapshotId: seedId,
    };
    const replacement = {
      sessionId: replacementId,
      status: 'running',
      sourceSnapshotId: seedId,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    };
    let session = old;
    let attachment: string | undefined = oldId;
    sandboxGet.mockImplementation(async ({ resume }: { resume: boolean }) => {
      if (resume) {
        session = replacement;
        attachment = replacementId;
        throw new Error('Synthetic resume acknowledgement lost');
      }
      return {
        persistent: false,
        currentSnapshotId: seedId,
        mounts: { '/workspace': { mode: 'read-write', drive: driveName } },
        currentSession: () => session,
      };
    });
    driveGet.mockImplementation(async () => ({
      driveId,
      name: driveName,
      currentSessionId: attachment,
      currentSandboxName: attachment ? sandboxName : undefined,
    }));
    expect(
      await store.compareManagedRuntime(sandboxName, null, {
        phase: 'ready',
        sessionId: oldId,
        driveId,
      }),
    ).toBe(true);

    const managed = createManagedWorker(
      { sandboxName, driveName, seedId },
      store,
    );
    const ready = () => managed.getSession(Date.now() + 15_000);
    expect(await ready()).toBeUndefined();
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(0);

    attachment = undefined;
    const beforeResume = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(beforeResume.signal);
    const compare = store.compareManagedRuntime.bind(store);
    vi.spyOn(store, 'compareManagedRuntime').mockImplementationOnce(
      async (...args) => {
        const claimed = await compare(...args);
        beforeResume.abort();
        return claimed;
      },
    );
    expect(await ready()).toBeUndefined();
    expect(await store.getManagedRuntime(sandboxName)).toMatchObject({
      phase: 'ready',
      sessionId: oldId,
    });
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(0);

    await expect(ready()).rejects.toThrow(
      'Synthetic resume acknowledgement lost',
    );
    expect(await store.getManagedRuntime(sandboxName)).toMatchObject({
      phase: 'starting',
      sessionId: oldId,
    });

    replacement.runCommand.mockResolvedValueOnce({ exitCode: 1 });
    expect(await ready()).toBeUndefined();
    expect(await store.getManagedRuntime(sandboxName)).toMatchObject({
      phase: 'starting',
      sessionId: oldId,
    });
    expect(replacement.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'bash', sudo: true }),
    );
    const [, prepareDrive] = replacement.runCommand.mock.calls[0]![0].args;
    expect(prepareDrive).toContain(
      'test ! -L /workspace && mountpoint -q /workspace',
    );
    expect(prepareDrive).toContain(
      'chown --no-dereference -- 1000:1000 /workspace',
    );
    expect(prepareDrive).toContain('--no-new-privs -- test -w /workspace');

    expect(await ready()).toBe(replacement);
    expect(await store.getManagedRuntime(sandboxName)).toEqual({
      phase: 'ready',
      sessionId: replacementId,
      driveId,
    });
    expect(
      await store.isIdleSessionOpen({ sandboxName, sessionId: replacementId }),
    ).toBe(true);
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(1);
  });

  it('migrates stopped-session reservations before admitting fresh work', async () => {
    sandboxGet.mockReset();
    driveGet.mockReset();
    const store = new RedisRunStore(state.getClient(), namespace);
    const sandboxName = 'synthetic-dispatch-worker';
    const driveName = 'synthetic-dispatch-drive';
    const seedId = 'synthetic-dispatch-seed';
    const driveId = 'synthetic-dispatch-drive-id';
    const old = {
      sessionId: 'synthetic-dispatch-old',
      status: 'stopped',
      sourceSnapshotId: seedId,
    };
    const replacement = {
      sessionId: 'synthetic-dispatch-replacement',
      status: 'running',
      sourceSnapshotId: seedId,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    };
    let session = old;
    let attachment: string | undefined;
    sandboxGet.mockImplementation(async ({ resume }: { resume: boolean }) => {
      if (resume) {
        session = replacement;
        attachment = replacement.sessionId;
      }
      return {
        persistent: false,
        currentSnapshotId: seedId,
        mounts: { '/workspace': { mode: 'read-write', drive: driveName } },
        currentSession: () => session,
      };
    });
    driveGet.mockImplementation(async () => ({
      driveId,
      name: driveName,
      currentSessionId: attachment,
      currentSandboxName: attachment ? sandboxName : undefined,
    }));
    expect(
      await store.compareManagedRuntime(sandboxName, null, {
        phase: 'ready',
        sessionId: old.sessionId,
        driveId,
      }),
    ).toBe(true);
    const makeRun = (): RunRecord => ({
      runId: randomUUID(),
      conversationId: 'a'.repeat(64),
      generation: 1,
      eventId: randomUUID(),
      workspaceId: 'T_SYNTHETIC',
      channelId: 'C_SYNTHETIC',
      threadTs: randomUUID(),
      messageTs: randomUUID(),
      senderId: 'U_SYNTHETIC',
      deadline: Date.now() + 60_000,
      callbackHash: 'b'.repeat(64),
      kind: 'work',
      state: 'accepted',
    });
    const makeJob = (run: RunRecord): WorkerJob => ({
      version: 1,
      runId: run.runId,
      conversationId: run.conversationId,
      generation: 1,
      input: {
        text: 'Synthetic work',
        senderId: run.senderId,
        workspaceId: run.workspaceId,
        channelId: run.channelId,
        threadTs: run.threadTs,
        messageTs: run.messageTs,
      },
      deadline: run.deadline,
      callbackUrl: 'https://gateway.example/api/worker/callback',
      callbackToken: 'c'.repeat(64),
    });
    const oldTarget = { sandboxName, sessionId: old.sessionId };
    const active = makeRun();
    await store.admit(active);
    expect(await store.enrollIdleSession(oldTarget)).toBe(true);
    expect(await store.recordDispatchTarget(makeJob(active), oldTarget)).toBe(
      'recorded',
    );
    const compare = vi.spyOn(store, 'compareManagedRuntime');
    compare.mockResolvedValueOnce(false);

    const managed = createManagedWorker(
      { sandboxName, driveName, seedId },
      store,
    );
    expect(await managed.getSession(Date.now() + 15_000)).toBeUndefined();
    expect(await store.isLostTarget(oldTarget)).toBe(true);
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(0);

    expect(await managed.getSession(Date.now() + 15_000)).toBe(replacement);
    const replacementTarget = {
      sandboxName,
      sessionId: replacement.sessionId,
    };
    expect(await store.getRun(active.runId)).toMatchObject({
      execution: oldTarget,
      recovery: replacementTarget,
    });

    const fresh = makeRun();
    await store.admit(fresh);
    expect(
      await store.recordDispatchTarget(makeJob(fresh), replacementTarget, true),
    ).toBe('recorded');
    expect(await store.getRun(active.runId)).toMatchObject({
      recovery: replacementTarget,
    });
    expect(await store.getRun(fresh.runId)).toMatchObject({
      execution: replacementTarget,
    });
  });

  it('replaces an exact session missing from a completed inventory but not an inventory failure', async () => {
    sandboxGet.mockReset();
    driveGet.mockReset();
    const store = new RedisRunStore(state.getClient(), namespace);
    const sandboxName = 'synthetic-missing-worker';
    const driveName = 'synthetic-missing-drive';
    const seedId = 'synthetic-missing-seed';
    const driveId = 'synthetic-missing-drive-id';
    const oldId = 'synthetic-missing-session';
    const replacementId = 'synthetic-recovered-session';
    const old = {
      sessionId: oldId,
      status: 'stopped',
      sourceSnapshotId: seedId,
    };
    const replacement = {
      sessionId: replacementId,
      status: 'running',
      sourceSnapshotId: seedId,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    };
    const secondReplacement = {
      sessionId: 'synthetic-recovered-session-2',
      status: 'running',
      sourceSnapshotId: seedId,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    };
    let session = old;
    let attachment: string | undefined;
    let inventoryFails = true;
    let resumes = 0;
    const listSessions = vi.fn(() => {
      if (inventoryFails) throw new Error('Synthetic provider outage');
      return (async function* () {
        yield { id: 'unrelated-stopped-session', status: 'stopped' };
      })();
    });
    sandboxGet.mockImplementation(async ({ resume }: { resume: boolean }) => {
      if (resume) {
        resumes += 1;
        session = resumes === 1 ? replacement : secondReplacement;
        attachment = session.sessionId;
      }
      return {
        persistent: false,
        currentSnapshotId: seedId,
        mounts: { '/workspace': { mode: 'read-write', drive: driveName } },
        currentSession: () => session,
        listSessions,
      };
    });
    driveGet.mockImplementation(async () => ({
      driveId,
      name: driveName,
      currentSessionId: attachment,
      currentSandboxName: attachment ? sandboxName : undefined,
    }));
    const target = { sandboxName, sessionId: oldId };
    expect(
      await store.compareManagedRuntime(sandboxName, null, {
        phase: 'ready',
        sessionId: oldId,
        driveId,
      }),
    ).toBe(true);
    expect(await store.enrollIdleSession(target)).toBe(true);

    const managed = createManagedWorker(
      { sandboxName, driveName, seedId },
      store,
    );
    await expect(
      managed.recoverSession(target, Date.now() + 15_000),
    ).rejects.toThrow('Synthetic provider outage');
    expect(await store.isIdleSessionOpen(target)).toBe(true);
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(0);

    inventoryFails = false;
    expect(await managed.recoverSession(target, Date.now() + 15_000)).toBe(
      replacement,
    );
    expect(await store.isIdleSessionOpen(target)).toBe(false);
    expect(
      await store.isIdleSessionOpen({
        sandboxName,
        sessionId: replacementId,
      }),
    ).toBe(true);
    expect(await store.getManagedRuntime(sandboxName)).toEqual({
      phase: 'ready',
      sessionId: replacementId,
      driveId,
    });
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(1);

    session = { ...replacement, status: 'stopped' };
    attachment = undefined;
    expect(
      await managed.recoverSession(
        { sandboxName, sessionId: replacementId },
        Date.now() + 15_000,
      ),
    ).toBe(secondReplacement);
    expect(
      await store.isIdleSessionOpen({
        sandboxName,
        sessionId: replacementId,
      }),
    ).toBe(false);
    expect(
      await store.isIdleSessionOpen({
        sandboxName,
        sessionId: secondReplacement.sessionId,
      }),
    ).toBe(true);
    expect(await store.getManagedRuntime(sandboxName)).toEqual({
      phase: 'ready',
      sessionId: secondReplacement.sessionId,
      driveId,
    });
    expect(
      sandboxGet.mock.calls.filter(([input]) => input.resume),
    ).toHaveLength(2);
  });
});
