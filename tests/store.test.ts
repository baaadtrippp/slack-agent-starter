import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  WorkerJob,
  WorkerResult,
} from '../packages/contracts/src/index.js';
import {
  RedisRunStore,
  type ManagedRuntime,
  type RunRecord,
  type SandboxTarget,
} from '../apps/gateway/src/store.js';

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('RedisRunStore', () => {
  const namespace = `slack-agent:m1:test:${randomUUID()}`;
  const state = createRedisState({
    url: redisUrl ?? 'redis://127.0.0.1:1',
    keyPrefix: namespace,
  });
  const store = new RedisRunStore(state.getClient(), namespace);

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

  it('admits an event once and deduplicates redelivery and logical messages', async () => {
    const first = makeRun();
    const [accepted, retry] = await Promise.all([
      store.admit(first),
      store.admit(first),
    ]);

    expect([accepted.outcome, retry.outcome].sort()).toEqual([
      'accepted',
      'duplicate',
    ]);

    const logicalDuplicate = await store.admit(
      makeRun({
        eventId: randomUUID(),
        workspaceId: first.workspaceId,
        channelId: first.channelId,
        messageTs: first.messageTs,
      }),
    );
    expect(logicalDuplicate.outcome).toBe('duplicate');
    expect(logicalDuplicate.run.runId).toBe(first.runId);
  });

  it('atomically admits one run and marks a concurrent thread request busy', async () => {
    const first = makeRun();
    const second = makeRun({
      threadTs: first.threadTs,
      messageTs: '1700000001.000002',
    });
    const outcomes = await Promise.all([
      store.admit(first),
      store.admit(second),
    ]);

    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
      'accepted',
      'busy',
    ]);
    const owner = outcomes.find(({ outcome }) => outcome === 'accepted');
    const busy = outcomes.find(({ outcome }) => outcome === 'busy');
    expect(owner?.run.kind).toBe('work');
    expect(busy?.run.kind).toBe('busy');
    expect(busy?.run.blockedBy).toBe(owner?.run.runId);
  });

  it('binds exactly one dispatch target only to the accepted thread owner', async () => {
    const run = makeRun();
    await store.admit(run);
    const targets: SandboxTarget[] = [
      { sandboxName: 'synthetic-a', sessionId: randomUUID() },
      { sandboxName: 'synthetic-b', sessionId: randomUUID() },
    ];
    const bound = await Promise.all(
      targets.map((target) => store.recordDispatchTarget(makeJob(run), target)),
    );
    expect(bound.sort()).toEqual(['conflict', 'recorded']);

    const saved = await store.getRun(run.runId);
    expect(targets).toContainEqual(saved?.execution);
    expect(
      await store.recordDispatchTarget(makeJob(run), {
        sandboxName: 'synthetic-c',
        sessionId: randomUUID(),
      }),
    ).toBe('conflict');

    const busy = makeRun({
      threadTs: run.threadTs,
      messageTs: nextTimestamp(),
    });
    expect((await store.admit(busy)).outcome).toBe('busy');
    expect(await store.recordDispatchTarget(makeJob(busy), targets[0]!)).toBe(
      'conflict',
    );
  });

  it('atomically advances one managed runtime candidate and accepts exact replays', async () => {
    const sandboxName = `synthetic-managed-${randomUUID()}`;
    const candidates: ManagedRuntime[] = [
      {
        phase: 'starting',
        sessionId: randomUUID(),
        driveId: randomUUID(),
        operationId: randomUUID(),
      },
      {
        phase: 'starting',
        sessionId: randomUUID(),
        driveId: randomUUID(),
        operationId: randomUUID(),
      },
    ];
    expect(await store.getManagedRuntime(sandboxName)).toBeNull();

    const outcomes = await Promise.all(
      candidates.map((candidate) =>
        store.compareManagedRuntime(sandboxName, null, candidate),
      ),
    );
    expect([...outcomes].sort()).toEqual([false, true]);
    const winner = candidates[outcomes.indexOf(true)]!;
    const loser = candidates[outcomes.indexOf(false)]!;
    expect(await store.getManagedRuntime(sandboxName)).toEqual(winner);
    expect(await store.compareManagedRuntime(sandboxName, null, winner)).toBe(
      true,
    );
    expect(await store.compareManagedRuntime(sandboxName, null, loser)).toBe(
      false,
    );

    const ready: ManagedRuntime = {
      phase: 'ready',
      sessionId: winner.sessionId,
      driveId: winner.driveId,
    };
    expect(await store.compareManagedRuntime(sandboxName, winner, ready)).toBe(
      true,
    );
    expect(
      await store.compareManagedRuntime(sandboxName, winner, {
        ...ready,
        sessionId: randomUUID(),
      }),
    ).toBe(false);
    expect(await store.compareManagedRuntime(sandboxName, null, ready)).toBe(
      true,
    );
    expect(await store.getManagedRuntime(sandboxName)).toEqual(ready);
    expect(
      await state.getClient().pTTL(managedRuntimeKey(namespace, sandboxName)),
    ).toBe(-1);
  });

  it('requires the exact ready managed session and an open idle gate', async () => {
    const unavailable = makeTarget('managed-missing');
    const unavailableRun = makeRun();
    await store.admit(unavailableRun);
    expect(
      await store.recordDispatchTarget(
        makeJob(unavailableRun),
        unavailable,
        true,
      ),
    ).toBe('unavailable');

    const starting = makeTarget('managed-starting');
    const startingRun = makeRun();
    await store.admit(startingRun);
    await store.compareManagedRuntime(starting.sandboxName, null, {
      phase: 'starting',
      sessionId: starting.sessionId,
      driveId: randomUUID(),
      operationId: randomUUID(),
    });
    expect(await store.enrollIdleSession(starting)).toBe(true);
    expect(
      await store.recordDispatchTarget(makeJob(startingRun), starting, true),
    ).toBe('unavailable');

    const stale = makeTarget('managed-stale');
    const staleRun = makeRun();
    await store.admit(staleRun);
    await store.compareManagedRuntime(stale.sandboxName, null, {
      phase: 'ready',
      sessionId: randomUUID(),
      driveId: randomUUID(),
    });
    expect(await store.enrollIdleSession(stale)).toBe(true);
    expect(
      await store.recordDispatchTarget(makeJob(staleRun), stale, true),
    ).toBe('unavailable');

    const closed = makeTarget('managed-closed');
    const closedRun = makeRun();
    await store.admit(closedRun);
    await store.compareManagedRuntime(closed.sandboxName, null, {
      phase: 'ready',
      sessionId: closed.sessionId,
      driveId: randomUUID(),
    });
    expect(await store.isIdleSessionOpen(closed)).toBe(false);
    expect(
      await store.recordDispatchTarget(makeJob(closedRun), closed, true),
    ).toBe('unavailable');

    const ready = makeTarget('managed-ready');
    const readyRun = makeRun();
    await store.admit(readyRun);
    await store.compareManagedRuntime(ready.sandboxName, null, {
      phase: 'ready',
      sessionId: ready.sessionId,
      driveId: randomUUID(),
    });
    expect(await store.enrollIdleSession(ready)).toBe(true);
    expect(await store.isIdleSessionOpen(ready)).toBe(true);
    expect(
      await store.recordDispatchTarget(makeJob(readyRun), ready, true),
    ).toBe('recorded');

    const stopping = makeTarget('managed-stopping');
    const stoppingRun = makeRun();
    await store.admit(stoppingRun);
    await store.compareManagedRuntime(stopping.sandboxName, null, {
      phase: 'ready',
      sessionId: stopping.sessionId,
      driveId: randomUUID(),
    });
    expect(await store.enrollIdleSession(stopping)).toBe(true);
    expect(await store.claimIdleStop(stopping, randomUUID())).toBe('claimed');
    expect(await store.isIdleSessionOpen(stopping)).toBe(false);
    expect(
      await store.recordDispatchTarget(makeJob(stoppingRun), stopping, true),
    ).toBe('stopping');

    const unmanaged = makeTarget('unmanaged');
    const unmanagedRun = makeRun();
    await store.admit(unmanagedRun);
    expect(
      await store.recordDispatchTarget(makeJob(unmanagedRun), unmanaged),
    ).toBe('recorded');
  });

  it('serializes dispatch and idle stop in either race order without reopening', async () => {
    const dispatchFirst = makeTarget('dispatch-first');
    const firstRun = makeRun();
    await store.admit(firstRun);
    expect(await store.enrollIdleSession(dispatchFirst)).toBe(true);
    expect(await store.enrollIdleSession(dispatchFirst)).toBe(true);
    expect(
      await store.recordDispatchTarget(makeJob(firstRun), dispatchFirst),
    ).toBe('recorded');
    expect(
      await store.claimIdleStop(dispatchFirst, 'operation-dispatch-first'),
    ).toBe('active');
    expect(
      await store.releaseDispatchTarget(firstRun.runId, dispatchFirst),
    ).toBe(true);
    expect(
      await store.claimIdleStop(dispatchFirst, 'operation-dispatch-first'),
    ).toBe('claimed');
    expect(
      await store.claimIdleStop(dispatchFirst, 'operation-dispatch-first'),
    ).toBe('claimed');
    expect(await store.claimIdleStop(dispatchFirst, 'operation-other')).toBe(
      'stopping',
    );
    expect(await store.enrollIdleSession(dispatchFirst)).toBe(false);
    expect(
      await state.getClient().pTTL(idleGateKey(namespace, dispatchFirst)),
    ).toBe(-1);

    const stopFirst = makeTarget('stop-first');
    const secondRun = makeRun();
    await store.admit(secondRun);
    expect(await store.enrollIdleSession(stopFirst)).toBe(true);
    expect(await store.claimIdleStop(stopFirst, 'operation-stop-first')).toBe(
      'claimed',
    );
    expect(
      await store.recordDispatchTarget(makeJob(secondRun), stopFirst),
    ).toBe('stopping');
    expect(await store.getRun(secondRun.runId)).not.toHaveProperty('execution');
    expect(await store.releaseDispatchTarget(secondRun.runId, stopFirst)).toBe(
      false,
    );

    const unenrolled = makeTarget('unenrolled');
    const thirdRun = makeRun();
    await store.admit(thirdRun);
    expect(
      await store.recordDispatchTarget(makeJob(thirdRun), unenrolled),
    ).toBe('recorded');
    expect(await store.claimIdleStop(unenrolled, 'operation-unenrolled')).toBe(
      'unenrolled',
    );
    expect(await store.enrollIdleSession(unenrolled)).toBe(false);
    expect(await store.releaseDispatchTarget(thirdRun.runId, unenrolled)).toBe(
      true,
    );
    expect(await store.enrollIdleSession(unenrolled)).toBe(true);
  });

  it('waits for every exact active reservation before claiming idle stop', async () => {
    const target = makeTarget('shared');
    const wrongTarget = makeTarget('wrong');
    const first = makeRun();
    const second = makeRun();
    await Promise.all([store.admit(first), store.admit(second)]);
    expect(await store.enrollIdleSession(target)).toBe(true);
    expect(await store.recordDispatchTarget(makeJob(first), target)).toBe(
      'recorded',
    );
    expect(await store.recordDispatchTarget(makeJob(second), target)).toBe(
      'recorded',
    );
    expect(await store.claimIdleStop(target, 'operation-shared')).toBe(
      'active',
    );

    expect(await store.releaseDispatchTarget(first.runId, wrongTarget)).toBe(
      false,
    );
    expect(await store.claimIdleStop(target, 'operation-shared')).toBe(
      'active',
    );
    const firstResult = makeResult(first);
    expect(
      await store.claimPublication(first.runId, firstResult, Date.now()),
    ).toBe('claimed');
    expect(await store.completePublication(first, nextTimestamp())).toBe(true);
    expect(await store.releaseDispatchTarget(first.runId, target)).toBe(true);
    expect(await store.claimIdleStop(target, 'operation-shared')).toBe(
      'active',
    );
    expect(await store.releaseDispatchTarget(second.runId, target)).toBe(true);
    expect(await store.claimIdleStop(target, 'operation-shared')).toBe(
      'claimed',
    );
  });

  it('fences one lost target and holds its replacement for every affected run', async () => {
    const lost = makeTarget('lost-shared');
    const replacement = makeTarget('lost-replacement');
    const unrelated = makeTarget('unrelated');
    const first = makeRun();
    const second = makeRun();
    const other = makeRun();
    await Promise.all([
      store.admit(first),
      store.admit(second),
      store.admit(other),
    ]);
    await Promise.all([
      store.enrollIdleSession(lost),
      store.enrollIdleSession(replacement),
      store.enrollIdleSession(unrelated),
    ]);
    expect(await store.recordDispatchTarget(makeJob(first), lost)).toBe(
      'recorded',
    );
    expect(await store.recordDispatchTarget(makeJob(second), lost)).toBe(
      'recorded',
    );
    expect(await store.recordDispatchTarget(makeJob(other), unrelated)).toBe(
      'recorded',
    );

    expect(await store.fenceLostTarget(lost)).toBe(true);
    expect(await store.fenceLostTarget(lost)).toBe(true);
    const refused = makeRun();
    await store.admit(refused);
    expect(await store.recordDispatchTarget(makeJob(refused), lost)).toBe(
      'stopping',
    );
    expect(await store.bindRecoveryTarget(lost, replacement)).toBe(true);
    expect(await store.bindRecoveryTarget(lost, replacement)).toBe(true);
    expect(await store.getRun(first.runId)).toMatchObject({
      execution: lost,
      recovery: replacement,
    });
    expect(await store.getRun(second.runId)).toMatchObject({
      execution: lost,
      recovery: replacement,
    });
    expect(await store.getRun(other.runId)).toMatchObject({
      execution: unrelated,
    });
    expect(await store.getRun(other.runId)).not.toHaveProperty('recovery');
    expect(await store.claimIdleStop(replacement, randomUUID())).toBe('active');
    expect(await store.claimIdleStop(unrelated, randomUUID())).toBe('active');

    const recoveredFirst = (await store.getRun(first.runId))!;
    const firstResult = makeResult(first);
    expect(await store.claimSavedResult(recoveredFirst, firstResult)).toBe(
      'claimed',
    );
    expect(await store.completePublication(first, nextTimestamp())).toBe(true);
    expect(await store.releaseDispatchTarget(first.runId, lost)).toBe(true);
    expect(await store.claimIdleStop(replacement, randomUUID())).toBe('active');

    const recoveredSecond = (await store.getRun(second.runId))!;
    expect(
      await store.interruptRun(recoveredSecond, recoveredSecond.deadline),
    ).toBe(true);
    expect(await store.getRun(second.runId)).toMatchObject({
      state: 'interrupted',
      execution: lost,
      recovery: replacement,
    });
    expect(await store.claimIdleStop(replacement, randomUUID())).toBe(
      'claimed',
    );
    expect(await store.claimIdleStop(unrelated, randomUUID())).toBe('active');

    expect(await store.releaseDispatchTarget(other.runId, unrelated)).toBe(
      true,
    );
  });

  it('atomically releases a current recovery binding after a delayed terminal callback', async () => {
    const lost = makeTarget('delayed-terminal');
    const replacement = makeTarget('delayed-terminal-replacement');
    const run = makeRun();
    await store.admit(run);
    await Promise.all([
      store.enrollIdleSession(lost),
      store.enrollIdleSession(replacement),
    ]);
    expect(await store.recordDispatchTarget(makeJob(run), lost)).toBe(
      'recorded',
    );
    expect(await store.fenceLostTarget(lost)).toBe(true);
    expect(await store.bindRecoveryTarget(lost, replacement)).toBe(true);
    const bound = (await store.getRun(run.runId))!;
    expect(await store.releaseRecoveryTarget(bound)).toBeUndefined();
    expect(await store.claimIdleStop(replacement, randomUUID())).toBe('active');

    expect(
      await store.claimPublication(run.runId, makeResult(run), Date.now()),
    ).toBe('claimed');
    expect(await store.completePublication(run, nextTimestamp())).toBe(true);
    expect(
      await store.releaseRecoveryTarget({ ...bound, eventId: randomUUID() }),
    ).toBeUndefined();
    expect(await store.claimIdleStop(replacement, randomUUID())).toBe('active');
    expect(await store.releaseRecoveryTarget(bound)).toEqual(replacement);
    expect(await store.claimIdleStop(replacement, randomUUID())).toBe(
      'claimed',
    );
    expect(
      await state.getClient().sCard(activeDispatchKey(namespace, lost)),
    ).toBe(0);
  });

  it('releases an ordinary terminal reservation only with confirmed exit proof', async () => {
    const callbackTarget = makeTarget('callback-result-exit');
    const callbackRun = makeRun();
    await store.admit(callbackRun);
    expect(await store.enrollIdleSession(callbackTarget)).toBe(true);
    expect(
      await store.recordDispatchTarget(makeJob(callbackRun), callbackTarget),
    ).toBe('recorded');
    const callbackObserved = (await store.getRun(callbackRun.runId))!;
    const callbackResult = makeResult(callbackRun);
    expect(
      await store.claimPublication(
        callbackRun.runId,
        callbackResult,
        Date.now(),
      ),
    ).toBe('claimed');
    expect(await store.completePublication(callbackRun, nextTimestamp())).toBe(
      true,
    );
    expect(await store.releaseRecoveryTarget(callbackObserved)).toBeUndefined();
    expect(await store.claimIdleStop(callbackTarget, randomUUID())).toBe(
      'active',
    );
    expect(await store.claimSavedResult(callbackObserved, callbackResult)).toBe(
      'duplicate',
    );
    expect(await store.getRun(callbackRun.runId)).toMatchObject({
      exitConfirmed: true,
    });
    expect(await store.releaseRecoveryTarget(callbackObserved)).toEqual(
      callbackTarget,
    );

    const savedTarget = makeTarget('saved-result-exit');
    const savedRun = makeRun();
    await store.admit(savedRun);
    expect(await store.enrollIdleSession(savedTarget)).toBe(true);
    expect(
      await store.recordDispatchTarget(makeJob(savedRun), savedTarget),
    ).toBe('recorded');
    const savedObserved = (await store.getRun(savedRun.runId))!;
    expect(
      await store.claimSavedResult(savedObserved, makeResult(savedRun)),
    ).toBe('claimed');
    expect(await store.completePublication(savedRun, nextTimestamp())).toBe(
      true,
    );
    expect(await store.getRun(savedRun.runId)).toMatchObject({
      exitConfirmed: true,
    });
    expect(
      await store.releaseRecoveryTarget({
        ...savedObserved,
        eventId: randomUUID(),
      }),
    ).toBeUndefined();
    expect(await store.claimIdleStop(savedTarget, randomUUID())).toBe('active');
    expect(await store.releaseRecoveryTarget(savedObserved)).toEqual(
      savedTarget,
    );
    expect(await store.claimIdleStop(savedTarget, randomUUID())).toBe(
      'claimed',
    );
  });

  it('holds an artifact claim while its exact target is fenced for recovery', async () => {
    const lost = makeTarget('artifact-lost');
    const replacement = makeTarget('artifact-replacement');
    const run = makeRun();
    const result = makeResult(run);
    await store.admit(run);
    await Promise.all([
      store.enrollIdleSession(lost),
      store.enrollIdleSession(replacement),
    ]);
    expect(await store.recordDispatchTarget(makeJob(run), lost)).toBe(
      'recorded',
    );
    const firstLease = randomUUID();
    expect(await store.reserveArtifactCollection(run.runId, firstLease)).toBe(
      true,
    );
    expect(await store.fenceLostTarget(lost)).toBe(true);
    expect(
      await store.claimPublication(
        run.runId,
        result,
        Date.now(),
        firstLease,
        lost,
      ),
    ).toBe('retry');
    const retryLease = randomUUID();
    expect(await store.reserveArtifactCollection(run.runId, retryLease)).toBe(
      true,
    );
    expect(await store.bindRecoveryTarget(lost, replacement)).toBe(true);
    expect(
      await store.claimPublication(
        run.runId,
        result,
        Date.now(),
        retryLease,
        lost,
      ),
    ).toBe('retry');
    const finalLease = randomUUID();
    expect(await store.reserveArtifactCollection(run.runId, finalLease)).toBe(
      true,
    );
    expect(
      await store.claimPublication(
        run.runId,
        result,
        Date.now(),
        finalLease,
        replacement,
      ),
    ).toBe('claimed');
  });

  it('returns an original target after exact Stop proof', async () => {
    const target = makeTarget('confirmed-stop');
    const run = makeRun({ controls: true, statusMessageId: nextTimestamp() });
    await store.admit(run);
    expect(await store.enrollIdleSession(target)).toBe(true);
    expect(await store.recordDispatchTarget(makeJob(run), target)).toBe(
      'recorded',
    );
    expect(
      await store.requestStop({
        runId: run.runId,
        generation: run.generation,
        statusMessageId: run.statusMessageId!,
      }),
    ).toBe('requested');
    const stopping = (await store.getRun(run.runId))!;
    expect(await store.confirmStopped(stopping)).toBe('confirmed');
    expect(await store.getRun(run.runId)).toMatchObject({
      state: 'stopped',
      exitConfirmed: true,
    });
    expect(await store.releaseRecoveryTarget(stopping)).toEqual(target);
  });

  it('unsubmits a proven prelaunch failure racing Stop without a failure result', async () => {
    const target = makeTarget('prelaunch-stop');
    const run = makeRun({
      controls: true,
      statusMessageId: nextTimestamp(),
    });
    await store.admit(run);
    expect(await store.enrollIdleSession(target)).toBe(true);
    expect(await store.recordDispatchTarget(makeJob(run), target)).toBe(
      'recorded',
    );
    expect(
      await store.requestStop({
        runId: run.runId,
        generation: run.generation,
        statusMessageId: run.statusMessageId!,
      }),
    ).toBe('requested');
    expect(await store.releaseDispatchTarget(run.runId, target, true)).toBe(
      true,
    );
    const stopping = (await store.getRun(run.runId))!;
    expect(stopping).toMatchObject({ state: 'stopping' });
    expect(stopping).not.toHaveProperty('execution');
    expect(
      await store.claimUnsubmitted(stopping, {
        ...makeResult(run),
        type: 'failed',
      }),
    ).toBe(false);
    expect(await store.confirmStopped(stopping)).toBe('confirmed');
    expect(await store.getRun(run.runId)).toMatchObject({ state: 'stopped' });
  });

  it('migrates affected reservations across a second exact runtime loss', async () => {
    const firstTarget = makeTarget('repeat-a');
    const secondTarget = makeTarget('repeat-b');
    const thirdTarget = makeTarget('repeat-c');
    const first = makeRun();
    const second = makeRun();
    await Promise.all([store.admit(first), store.admit(second)]);
    await Promise.all([
      store.enrollIdleSession(firstTarget),
      store.enrollIdleSession(secondTarget),
      store.enrollIdleSession(thirdTarget),
    ]);
    expect(await store.recordDispatchTarget(makeJob(first), firstTarget)).toBe(
      'recorded',
    );
    expect(await store.recordDispatchTarget(makeJob(second), firstTarget)).toBe(
      'recorded',
    );
    expect(await store.fenceLostTarget(firstTarget)).toBe(true);
    expect(await store.bindRecoveryTarget(firstTarget, secondTarget)).toBe(
      true,
    );
    expect(await store.fenceLostTarget(secondTarget)).toBe(true);
    expect(await store.bindRecoveryTarget(secondTarget, thirdTarget)).toBe(
      true,
    );

    for (const run of [first, second])
      expect(await store.getRun(run.runId)).toMatchObject({
        execution: firstTarget,
        recovery: thirdTarget,
      });
    expect(
      await state.getClient().sCard(activeDispatchKey(namespace, firstTarget)),
    ).toBe(2);
    expect(
      await state.getClient().sCard(activeDispatchKey(namespace, secondTarget)),
    ).toBe(0);
    expect(
      await state.getClient().sCard(activeDispatchKey(namespace, thirdTarget)),
    ).toBe(2);

    const firstBound = (await store.getRun(first.runId))!;
    expect(
      await store.claimPublication(first.runId, makeResult(first), Date.now()),
    ).toBe('claimed');
    expect(await store.completePublication(first, nextTimestamp())).toBe(true);
    expect(await store.releaseRecoveryTarget(firstBound)).toEqual(thirdTarget);
    expect(await store.claimIdleStop(thirdTarget, randomUUID())).toBe('active');

    const secondBound = (await store.getRun(second.runId))!;
    expect(await store.interruptRun(secondBound, secondBound.deadline)).toBe(
      true,
    );
    expect(await store.claimIdleStop(thirdTarget, randomUUID())).toBe(
      'claimed',
    );
    expect(
      await state.getClient().sCard(activeDispatchKey(namespace, firstTarget)),
    ).toBe(0);
  });

  it('claims a callback once and releases only its own thread lease on completion', async () => {
    const run = makeRun({ conversationId: 'd'.repeat(64) });
    await store.admit(run);
    const session = {
      seedRunId: run.runId,
      nativeId: randomUUID(),
      adapterId: randomUUID(),
      revision: 4,
      hasRetainedSources: true as const,
    };
    const result = { ...makeResult(run), session };

    expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
      'claimed',
    );
    expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
      'duplicate',
    );
    expect(
      await store.claimPublication(
        run.runId,
        {
          ...result,
          session: {
            seedRunId: session.seedRunId,
            nativeId: session.nativeId,
            adapterId: session.adapterId,
            revision: session.revision,
          },
        },
        Date.now(),
      ),
    ).toBe('conflict');
    expect(await store.completePublication(run, '1700000002.000003')).toBe(
      true,
    );

    const next = await store.admit(
      makeRun({
        conversationId: run.conversationId,
        threadTs: run.threadTs,
        messageTs: '1700000003.000004',
      }),
    );
    expect(next.outcome).toBe('accepted');
    expect(next.run.session).toEqual(session);
  });

  it('rejects stale generations, expired runs, and callbacks for missing runs', async () => {
    const run = makeRun();
    await store.admit(run);

    expect(
      await store.claimPublication(
        run.runId,
        { ...makeResult(run), generation: 2 },
        Date.now(),
      ),
    ).toBe('conflict');
    expect(
      await store.claimPublication(
        run.runId,
        { ...makeResult(run), runId: randomUUID() },
        Date.now(),
      ),
    ).toBe('conflict');
    expect(
      await store.claimPublication(
        run.runId,
        makeResult(run),
        run.deadline + 1,
      ),
    ).toBe('expired');
    expect(
      await store.claimPublication(randomUUID(), makeResult(run), Date.now()),
    ).toBe('conflict');
  });

  it('retains ownership after uncertain publication and dispatch failure', async () => {
    const publication = makeRun();
    await store.admit(publication);
    const result = makeResult(publication);
    await store.claimPublication(publication.runId, result, Date.now());
    expect(await store.failPublication(publication.runId)).toBe(true);
    expect(
      await store.claimPublication(publication.runId, result, Date.now()),
    ).toBe('duplicate');
    expect(
      (
        await store.admit(
          makeRun({
            threadTs: publication.threadTs,
            messageTs: '1700000004.000005',
          }),
        )
      ).outcome,
    ).toBe('busy');

    const dispatch = makeRun();
    await store.admit(dispatch);
    expect(await store.failDispatch(dispatch.runId)).toBe(true);
    expect(
      (
        await store.admit(
          makeRun({
            threadTs: dispatch.threadTs,
            messageTs: '1700000006.000007',
          }),
        )
      ).outcome,
    ).toBe('busy');
  });

  it('does not clear another run when completing a busy response', async () => {
    const owner = makeRun();
    const busy = makeRun({
      threadTs: owner.threadTs,
      messageTs: '1700000007.000008',
    });
    await store.admit(owner);
    const busyAdmission = await store.admit(busy);
    const busyRun = busyAdmission.run;
    const result = makeResult(busyRun);

    expect(busyAdmission.outcome).toBe('busy');
    expect(await store.claimPublication(busy.runId, result, Date.now())).toBe(
      'claimed',
    );
    expect(await store.completePublication(busyRun, '1700000008.000009')).toBe(
      true,
    );
    expect(
      (
        await store.admit(
          makeRun({
            threadTs: owner.threadTs,
            messageTs: '1700000009.000010',
          }),
        )
      ).outcome,
    ).toBe('busy');
  });

  it('limits deadline-independent refusals to unbound thread owners', async () => {
    const run = makeRun();
    await store.admit(run);
    const result: WorkerResult = { ...makeResult(run), type: 'failed' };
    expect(await store.claimUnsubmitted(run, makeResult(run))).toBe(false);
    expect(
      await store.claimUnsubmitted(
        { ...run, threadTs: nextTimestamp() },
        result,
      ),
    ).toBe(false);
    expect(await store.claimPublication(run.runId, result, run.deadline)).toBe(
      'expired',
    );
    expect(
      await store.recordDispatchTarget(makeJob(run), {
        sandboxName: 'synthetic-refusal',
        sessionId: randomUUID(),
      }),
    ).toBe('recorded');
    expect(await store.claimUnsubmitted(run, result)).toBe(false);
    expect(await store.getRun(run.runId)).toMatchObject({ state: 'accepted' });
  });

  it('interrupts only an expired bound owner and preserves its evidence', async () => {
    const run = makeRun();
    const target = {
      sandboxName: 'synthetic-interrupted',
      sessionId: randomUUID(),
    };
    await store.admit(run);
    expect(await store.recordDispatchTarget(makeJob(run), target)).toBe(
      'recorded',
    );
    const bound = await store.getRun(run.runId);
    expect(bound).not.toBeNull();
    expect(await store.interruptRun(bound!, run.deadline - 1)).toBe(false);
    const interrupted = await Promise.all([
      store.interruptRun(bound!, run.deadline),
      store.interruptRun(bound!, run.deadline),
    ]);
    expect(interrupted).toEqual([true, true]);
    expect(
      await store.claimPublication(
        run.runId,
        makeResult(run),
        run.deadline - 1,
      ),
    ).toBe('conflict');
    expect(await store.getRun(run.runId)).toMatchObject({
      state: 'interrupted',
      execution: target,
    });

    const duplicate = await store.admit(run);
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicate.run.state).toBe('interrupted');
    const next = await store.admit(
      makeRun({ threadTs: run.threadTs, messageTs: nextTimestamp() }),
    );
    expect(next.outcome).toBe('accepted');
    expect(await store.interruptRun(bound!, run.deadline)).toBe(false);
    expect(
      (await store.admit(makeRun({ threadTs: run.threadTs }))).run.blockedBy,
    ).toBe(next.run.runId);
  });

  it('does not interrupt an unbound, changed, native, or no-longer-owned run', async () => {
    const unbound = makeRun();
    await store.admit(unbound);
    expect(await store.interruptRun(unbound, unbound.deadline)).toBe(false);

    const changed = makeRun();
    await store.admit(changed);
    const target = {
      sandboxName: 'synthetic-current',
      sessionId: randomUUID(),
    };
    await store.recordDispatchTarget(makeJob(changed), target);
    const bound = (await store.getRun(changed.runId))!;
    expect(
      await store.interruptRun(
        {
          ...bound,
          execution: { ...target, sessionId: randomUUID() },
        },
        changed.deadline,
      ),
    ).toBe(false);

    const native = makeRun({
      session: {
        seedRunId: randomUUID(),
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 3,
      },
    });
    await store.admit(native);
    await store.recordDispatchTarget(makeJob(native), target);
    expect(
      await store.interruptRun(
        (await store.getRun(native.runId))!,
        native.deadline,
      ),
    ).toBe(false);

    const withResult = makeRun();
    await store.admit(withResult);
    await store.recordDispatchTarget(makeJob(withResult), target);
    expect(
      await store.claimPublication(
        withResult.runId,
        makeResult(withResult),
        withResult.deadline - 1,
      ),
    ).toBe('claimed');
    expect(
      await store.interruptRun(
        (await store.getRun(withResult.runId))!,
        withResult.deadline,
      ),
    ).toBe(false);

    const noLongerOwned = makeRun();
    await store.admit(noLongerOwned);
    await store.recordDispatchTarget(makeJob(noLongerOwned), target);
    const stale = (await store.getRun(noLongerOwned.runId))!;
    const replacementOwner = randomUUID();
    const ownerKey = `${namespace}:owner:${noLongerOwned.workspaceId}:${noLongerOwned.channelId}:${noLongerOwned.threadTs}`;
    await state.getClient().set(ownerKey, replacementOwner);
    expect(await store.interruptRun(stale, noLongerOwned.deadline)).toBe(false);
    expect(await state.getClient().get(ownerKey)).toBe(replacementOwner);

    const failedDispatch = makeRun();
    await store.admit(failedDispatch);
    await store.recordDispatchTarget(makeJob(failedDispatch), target);
    expect(await store.failDispatch(failedDispatch.runId)).toBe(true);
    expect(
      await store.interruptRun(
        (await store.getRun(failedDispatch.runId))!,
        failedDispatch.deadline,
      ),
    ).toBe(true);
  });
});

let timestampCounter = 0;

function nextTimestamp(): string {
  timestampCounter += 1;
  return `${1700000000 + timestampCounter}.000001`;
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const threadTs = nextTimestamp();
  return {
    runId: randomUUID(),
    conversationId: 'a'.repeat(64),
    generation: 1,
    eventId: randomUUID(),
    workspaceId: 'T_SYNTHETIC',
    channelId: 'C_SYNTHETIC',
    threadTs,
    messageTs: nextTimestamp(),
    senderId: 'U_SYNTHETIC',
    deadline: Date.now() + 60_000,
    callbackHash: 'b'.repeat(64),
    kind: 'work',
    state: 'accepted',
    ...overrides,
  };
}

function makeResult(run: RunRecord): WorkerResult {
  return {
    version: 1,
    runId: run.runId,
    generation: run.generation,
    eventId: randomUUID(),
    sequence: 1,
    type: 'completed',
    text: 'Synthetic canned reply.',
  };
}

function makeJob(run: RunRecord): WorkerJob {
  return {
    version: 1,
    runId: run.runId,
    conversationId: run.conversationId,
    generation: run.generation,
    input: {
      text: 'Synthetic store test.',
      senderId: run.senderId,
      workspaceId: run.workspaceId,
      channelId: run.channelId,
      threadTs: run.threadTs,
      messageTs: run.messageTs,
    },
    session: run.session,
    deadline: run.deadline,
    callbackUrl: 'https://gateway.example/api/worker/callback',
    callbackToken: 'c'.repeat(64),
  };
}

function makeTarget(label: string): SandboxTarget {
  return { sandboxName: `synthetic-${label}`, sessionId: randomUUID() };
}

function idleGateKey(namespace: string, target: SandboxTarget): string {
  return `${namespace}:idle:${target.sandboxName}:${target.sessionId}:gate`;
}

function activeDispatchKey(namespace: string, target: SandboxTarget): string {
  return `${namespace}:idle:${target.sandboxName}:${target.sessionId}:active`;
}

function managedRuntimeKey(namespace: string, sandboxName: string): string {
  return `${namespace}:runtime:${sandboxName}:managed`;
}
