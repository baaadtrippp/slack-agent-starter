import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  WorkerJob,
  WorkerProgress,
  WorkerResult,
} from '../packages/contracts/src/index.js';
import {
  RedisRunStore,
  type RunRecord,
  type SandboxTarget,
} from '../apps/gateway/src/store.js';

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('F07 Redis progress and status state', () => {
  const namespace = `slack-agent:f07:test:${randomUUID()}`;
  const state = createRedisState({
    url: redisUrl ?? 'redis://127.0.0.1:1',
    keyPrefix: namespace,
  });
  const store = new RedisRunStore(state.getClient(), namespace);

  function loseNextEvalResponse() {
    const client = state.getClient();
    const evaluate = client.eval.bind(client);
    return vi
      .spyOn(client, 'eval')
      .mockImplementationOnce(async (script, options) => {
        await evaluate(script, options);
        throw new Error('Synthetic Redis response loss after commit');
      });
  }

  beforeAll(async () => {
    await state.connect();
  });

  afterAll(async () => {
    const client = state.getClient();
    for await (const key of client.scanIterator({ MATCH: `${namespace}:*` })) {
      if (key.length > 0) await client.del(key);
    }
    await state.disconnect();
  });

  it('claims and records one status only for the admitted work run', async () => {
    const owner = makeRun();
    const busy = makeRun({
      threadTs: owner.threadTs,
      messageTs: nextTimestamp(),
    });
    expect((await store.admit(owner)).outcome).toBe('accepted');
    expect((await store.admit(busy)).outcome).toBe('busy');

    expect(await store.claimStatusCreation(owner.runId)).toBe(true);
    expect(await store.claimStatusCreation(owner.runId)).toBe(false);
    expect(await store.recordStatusMessage(owner.runId, owner.messageTs)).toBe(
      true,
    );
    expect(await store.recordStatusMessage(owner.runId, owner.messageTs)).toBe(
      true,
    );
    expect(await store.recordStatusMessage(owner.runId, nextTimestamp())).toBe(
      false,
    );
    expect(await store.claimStatusCreation(busy.runId)).toBe(false);
    expect(await store.recordStatusMessage(busy.runId, nextTimestamp())).toBe(
      false,
    );
    expect(await store.claimStatusCreation(randomUUID())).toBe(false);
    expect(await store.getRun(owner.runId)).toMatchObject({
      statusClaimed: true,
      statusMessageId: owner.messageTs,
      statusVersion: 1,
    });
  });

  it('recovers when Redis commits status state but loses the response', async () => {
    const run = makeRun();
    await store.admit(run);

    let lost = loseNextEvalResponse();
    expect(await store.claimStatusCreation(run.runId)).toBe(true);
    lost.mockRestore();
    expect(await store.claimStatusCreation(run.runId)).toBe(false);

    lost = loseNextEvalResponse();
    expect(await store.recordStatusMessage(run.runId, run.messageTs)).toBe(
      true,
    );
    lost.mockRestore();
    expect(await store.recordStatusMessage(run.runId, run.messageTs)).toBe(
      true,
    );
    expect(await store.recordStatusMessage(run.runId, nextTimestamp())).toBe(
      false,
    );

    const token = randomUUID();
    lost = loseNextEvalResponse();
    expect(await store.claimStatusEdit(run.runId, token)).toBe(true);
    lost.mockRestore();
    expect(await store.claimStatusEdit(run.runId, randomUUID())).toBe(false);

    const version = (await store.getRun(run.runId))!.statusVersion!;
    expect(await store.failDispatch(run.runId)).toBe(true);
    lost = loseNextEvalResponse();
    expect(await store.finishStatusEdit(run.runId, token, version)).toBe(
      'changed',
    );
    lost.mockRestore();

    const changedVersion = (await store.getRun(run.runId))!.statusVersion!;
    lost = loseNextEvalResponse();
    expect(await store.finishStatusEdit(run.runId, token, changedVersion)).toBe(
      'lost',
    );
    lost.mockRestore();

    const nextToken = randomUUID();
    expect(await store.claimStatusEdit(run.runId, nextToken)).toBe(true);
    expect(await store.finishStatusEdit(run.runId, nextToken)).toBe('done');
  });

  it('accepts one exact progress event for the bound owner', async () => {
    const run = makeRun();
    const target = makeTarget();
    await store.admit(run);
    expect(await store.recordDispatchTarget(makeJob(run), target)).toBe(
      'recorded',
    );
    const progress = makeProgress(run);

    expect(await store.claimProgress(progress, run.deadline - 1)).toBe(
      'claimed',
    );
    expect(await store.claimProgress(progress, run.deadline - 1)).toBe(
      'duplicate',
    );
    expect(
      await store.claimProgress(
        { ...progress, eventId: randomUUID() },
        run.deadline - 1,
      ),
    ).toBe('conflict');
    expect(
      await store.claimProgress(
        { ...progress, generation: 2 },
        run.deadline - 1,
      ),
    ).toBe('conflict');
    expect(await store.getRun(run.runId)).toMatchObject({
      progress,
      statusVersion: 1,
    });
  });

  it('rejects progress without the exact live execution and thread owner', async () => {
    const unbound = makeRun();
    await store.admit(unbound);
    expect(
      await store.claimProgress(makeProgress(unbound), unbound.deadline - 1),
    ).toBe('conflict');

    const expired = makeRun();
    await store.admit(expired);
    await store.recordDispatchTarget(makeJob(expired), makeTarget());
    expect(
      await store.claimProgress(makeProgress(expired), expired.deadline),
    ).toBe('expired');

    const displaced = makeRun();
    await store.admit(displaced);
    await store.recordDispatchTarget(makeJob(displaced), makeTarget());
    await state.getClient().set(ownerKey(namespace, displaced), randomUUID());
    expect(
      await store.claimProgress(
        makeProgress(displaced),
        displaced.deadline - 1,
      ),
    ).toBe('conflict');
  });

  it('lets terminal state win before progress and after a newer owner is admitted', async () => {
    const run = makeRun();
    await store.admit(run);
    await store.recordDispatchTarget(makeJob(run), makeTarget());
    const terminal = makeResult(run);
    expect(
      await store.claimPublication(run.runId, terminal, run.deadline - 1),
    ).toBe('claimed');
    expect(await store.claimProgress(makeProgress(run), run.deadline - 1)).toBe(
      'conflict',
    );
    expect(await store.completePublication(run, nextTimestamp())).toBe(true);

    const next = makeRun({
      threadTs: run.threadTs,
      messageTs: nextTimestamp(),
    });
    expect((await store.admit(next)).outcome).toBe('accepted');
    expect(await store.claimProgress(makeProgress(run), run.deadline - 1)).toBe(
      'conflict',
    );
    expect(await store.getRun(run.runId)).toMatchObject({
      state: 'completed',
      result: terminal,
    });
    expect(await store.getRun(next.runId)).toMatchObject({ state: 'accepted' });
  });

  it('drains a version change under one token-owned status edit lease', async () => {
    const run = makeRun();
    await store.admit(run);
    await store.claimStatusCreation(run.runId);
    await store.recordStatusMessage(run.runId, nextTimestamp());
    await store.recordDispatchTarget(makeJob(run), makeTarget());
    const firstVersion = (await store.getRun(run.runId))!.statusVersion!;
    const firstToken = randomUUID();
    const secondToken = randomUUID();

    expect(await store.claimStatusEdit(run.runId, firstToken)).toBe(true);
    expect(await store.claimStatusEdit(run.runId, secondToken)).toBe(false);
    expect(await store.claimProgress(makeProgress(run), run.deadline - 1)).toBe(
      'claimed',
    );
    expect(
      await store.finishStatusEdit(run.runId, firstToken, firstVersion),
    ).toBe('changed');

    const changedVersion = (await store.getRun(run.runId))!.statusVersion!;
    expect(changedVersion).toBeGreaterThan(firstVersion);
    expect(
      await store.finishStatusEdit(run.runId, secondToken, changedVersion),
    ).toBe('lost');
    expect(
      await store.finishStatusEdit(run.runId, firstToken, changedVersion),
    ).toBe('done');

    expect(await store.claimStatusEdit(run.runId, secondToken)).toBe(true);
    expect(
      await store.finishStatusEdit(run.runId, firstToken, changedVersion),
    ).toBe('lost');
    expect(await store.claimStatusEdit(run.runId, randomUUID())).toBe(false);
    expect(
      await store.finishStatusEdit(run.runId, secondToken, changedVersion),
    ).toBe('done');
  });
});

let timestampCounter = 0;

function nextTimestamp(): string {
  timestampCounter += 1;
  return `${1_900_000_000 + timestampCounter}.000001`;
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const threadTs = nextTimestamp();
  return {
    runId: randomUUID(),
    conversationId: 'c'.repeat(64),
    generation: 1,
    eventId: randomUUID(),
    workspaceId: 'T_SYNTHETIC',
    channelId: 'C_SYNTHETIC',
    threadTs,
    messageTs: nextTimestamp(),
    senderId: 'U_SYNTHETIC',
    deadline: Date.now() + 60_000,
    callbackHash: 'd'.repeat(64),
    kind: 'work',
    state: 'accepted',
    ...overrides,
  };
}

function makeTarget(): SandboxTarget {
  return {
    sandboxName: `synthetic-${randomUUID()}`,
    sessionId: randomUUID(),
  };
}

function makeJob(run: RunRecord): WorkerJob {
  return {
    version: 1,
    runId: run.runId,
    conversationId: run.conversationId,
    generation: run.generation,
    input: {
      text: 'Synthetic task.',
      senderId: run.senderId,
      workspaceId: run.workspaceId,
      channelId: run.channelId,
      threadTs: run.threadTs,
      messageTs: run.messageTs,
    },
    deadline: run.deadline,
    callbackUrl: 'https://gateway.example/api/worker/callback',
    callbackToken: 'e'.repeat(64),
  };
}

function makeProgress(run: RunRecord): WorkerProgress {
  return {
    version: 1,
    runId: run.runId,
    generation: run.generation,
    eventId: randomUUID(),
    sequence: 1,
    type: 'working',
  };
}

function makeResult(run: RunRecord): WorkerResult {
  return {
    version: 1,
    runId: run.runId,
    generation: run.generation,
    eventId: randomUUID(),
    sequence: 2,
    type: 'completed',
    text: 'Synthetic final answer.',
  };
}

function ownerKey(namespace: string, run: RunRecord): string {
  return `${namespace}:owner:${run.workspaceId}:${run.channelId}:${run.threadTs}`;
}
