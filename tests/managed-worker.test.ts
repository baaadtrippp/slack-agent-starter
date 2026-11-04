import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createManagedWorker } from '../apps/gateway/src/managed-worker.js';
import { RedisRunStore } from '../apps/gateway/src/store.js';

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
});
