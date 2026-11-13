import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerProgress } from '../packages/contracts/src/index.js';
import type { RunRecord } from '../apps/gateway/src/store.js';
import {
  makeJob,
  makeResult,
  makeRun,
  makeTarget,
  nextTimestamp,
  recordReadyDispatch,
  redisUrl,
  useRedisStore,
} from './store-fixture.js';

describe.skipIf(!redisUrl)('F07 Redis progress and status state', () => {
  const { namespace, state, store } = useRedisStore();

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

  it('recovers when Redis records the attachment outcome but loses the response', async () => {
    const run = makeRun();
    await store.admit(run);
    const result = { ...makeResult(run), artifact: { sha256: 'a'.repeat(64) } };
    expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
      'claimed',
    );
    expect(await store.completePublication(run, nextTimestamp())).toBe(true);
    const lost = loseNextEvalResponse();
    expect(await store.recordArtifactPublication(run.runId, 'uploaded')).toBe(
      true,
    );
    lost.mockRestore();
    expect(await store.recordArtifactPublication(run.runId, 'failed')).toBe(
      false,
    );
  });

  it('accepts one exact progress event for the bound owner', async () => {
    const run = makeRun();
    const target = makeTarget();
    await store.admit(run);
    expect(await recordReadyDispatch(store, makeJob(run), target)).toBe(
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
    await recordReadyDispatch(store, makeJob(expired), makeTarget());
    expect(
      await store.claimProgress(makeProgress(expired), expired.deadline),
    ).toBe('expired');

    const displaced = makeRun();
    await store.admit(displaced);
    await recordReadyDispatch(store, makeJob(displaced), makeTarget());
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
    await recordReadyDispatch(store, makeJob(run), makeTarget());
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
    await recordReadyDispatch(store, makeJob(run), makeTarget());
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

function ownerKey(namespace: string, run: RunRecord): string {
  return `${namespace}:owner:${run.workspaceId}:${run.channelId}:${run.threadTs}`;
}
