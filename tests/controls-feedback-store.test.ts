import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  WorkerJob,
  WorkerResult,
  WorkerSession,
} from '../packages/contracts/src/index.js';
import {
  RedisRunStore,
  type AnswerRef,
  type RunRecord,
  type SandboxTarget,
} from '../apps/gateway/src/store.js';

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('F09/F11 Redis controls and feedback state', () => {
  const namespace = `slack-agent:controls:test:${randomUUID()}`;
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

  it('atomically lets either Stop or terminal publication win', async () => {
    const run = await admitControlledRun();
    const target = makeTarget();
    expect(await recordReadyDispatch(store, makeJob(run), target)).toBe(
      'recorded',
    );
    const saved = (await store.getRun(run.runId))!;
    const result = makeResult(run);

    const [stop, publication] = await Promise.all([
      store.requestStop(controlRef(run)),
      store.claimPublication(run.runId, result, run.deadline - 1),
    ]);

    if (stop === 'requested') {
      expect(publication).toBe('conflict');
      expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
        'conflict',
      );
      expect(await store.confirmStopped(saved)).toBe('conflict');
      const stopping = (await store.getRun(run.runId))!;
      expect(stopping.state).toBe('stopping');
      expect(await store.confirmStopped(stopping)).toBe('confirmed');
      expect(await store.confirmStopped(stopping)).toBe('duplicate');
      expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
        'conflict',
      );
    } else {
      expect(stop).toBe('terminal');
      expect(publication).toBe('claimed');
      expect(await store.completePublication(run, nextTimestamp())).toBe(true);
      expect(await store.requestStop(controlRef(run))).toBe('terminal');
    }
  });

  it('binds Stop to the exact control even after the work deadline', async () => {
    const run = await admitControlledRun({ deadline: Date.now() - 1 });
    expect(
      await store.requestStop({
        ...controlRef(run),
        generation: run.generation + 1,
      }),
    ).toBe('conflict');
    expect(
      await store.requestStop({
        ...controlRef(run),
        statusMessageId: nextTimestamp(),
      }),
    ).toBe('conflict');
    expect(await store.requestStop(controlRef(run))).toBe('requested');
    expect(await store.requestStop(controlRef(run))).toBe('duplicate');
  });

  it('releases only the confirmed stopped run and never a newer owner', async () => {
    const target = makeTarget();
    const first = await admitControlledRun();
    const other = await admitControlledRun();
    expect(await store.enrollIdleSession(target)).toBe(true);
    expect(await recordReadyDispatch(store, makeJob(first), target)).toBe(
      'recorded',
    );
    expect(await recordReadyDispatch(store, makeJob(other), target)).toBe(
      'recorded',
    );
    expect(await store.requestStop(controlRef(first))).toBe('requested');
    const stopping = (await store.getRun(first.runId))!;
    expect(await store.confirmStopped(stopping)).toBe('confirmed');
    expect(await store.claimIdleStop(target, randomUUID())).toBe('active');

    const next = makeRun({
      threadTs: first.threadTs,
      messageTs: nextTimestamp(),
    });
    expect((await store.admit(next)).outcome).toBe('accepted');
    expect(await store.confirmStopped(stopping)).toBe('conflict');
    expect(
      (
        await store.admit(
          makeRun({
            threadTs: first.threadTs,
            messageTs: nextTimestamp(),
          }),
        )
      ).outcome,
    ).toBe('busy');
  });

  it('fences idle shutdown while replacement recovery reads the Drive', async () => {
    const target = makeTarget();
    const reader = randomUUID();
    const stop = randomUUID();
    expect(await store.enrollIdleSession(target)).toBe(true);
    expect(await store.reserveRecovery(target, reader)).toBe(true);
    expect(await store.reserveRecovery(target, randomUUID())).toBe(false);
    expect(await store.claimIdleStop(target, stop)).toBe('active');
    await store.finishRecovery(target, randomUUID());
    expect(await store.claimIdleStop(target, stop)).toBe('active');
    await store.finishRecovery(target, reader);
    expect(await store.claimIdleStop(target, stop)).toBe('claimed');
    expect(await store.reserveRecovery(target, reader)).toBe(false);
  });

  it('clears a never-launched stopping target before confirming exit', async () => {
    const run = await admitControlledRun();
    const target = makeTarget();
    expect(await recordReadyDispatch(store, makeJob(run), target)).toBe(
      'recorded',
    );
    expect(await store.requestStop(controlRef(run))).toBe('requested');
    expect(await store.releaseDispatchTarget(run.runId, target, true)).toBe(
      true,
    );
    const unbound = (await store.getRun(run.runId))!;
    expect(unbound).not.toHaveProperty('execution');
    expect(await store.confirmStopped(unbound)).toBe('confirmed');
  });

  it('keeps the same native session resumable when its saved checkpoint beats worker exit', async () => {
    const seed = await admitControlledRun();
    const previous: WorkerSession = {
      seedRunId: seed.runId,
      nativeId: randomUUID(),
      adapterId: randomUUID(),
      revision: 5,
      hasRetainedSources: true,
    };
    expect(
      await store.claimPublication(
        seed.runId,
        {
          ...makeResult(seed),
          session: previous,
        },
        Date.now(),
      ),
    ).toBe('claimed');
    expect(await store.completePublication(seed, nextTimestamp())).toBe(true);
    const resumed = await admitControlledRun({
      threadTs: seed.threadTs,
      conversationId: seed.conversationId,
    });
    expect(resumed.session).toEqual(previous);
    expect(await store.requestStop(controlRef(resumed))).toBe('requested');
    const stopping = (await store.getRun(resumed.runId))!;
    const checkpoint = { ...previous, revision: 8 };
    expect(
      await store.confirmStopped(stopping, {
        ...checkpoint,
        nativeId: randomUUID(),
      }),
    ).toBe('conflict');
    expect(await store.confirmStopped(stopping, checkpoint)).toBe('confirmed');
    const next = await store.admit(
      makeRun({
        threadTs: seed.threadTs,
        conversationId: seed.conversationId,
      }),
    );
    expect(next.run.session).toEqual(checkpoint);
    expect(await store.getRun(resumed.runId)).toMatchObject({
      state: 'stopped',
    });
    expect((await store.getRun(resumed.runId))?.result).toBeUndefined();
  });

  it('claims a proved saved result without replay and retains its exact session', async () => {
    const run = await admitControlledRun({
      conversationId: 'd'.repeat(64),
    });
    const target = makeTarget();
    expect(await recordReadyDispatch(store, makeJob(run), target)).toBe(
      'recorded',
    );
    const observed = (await store.getRun(run.runId))!;
    const session: WorkerSession = {
      seedRunId: run.runId,
      nativeId: randomUUID(),
      adapterId: randomUUID(),
      revision: 3,
      hasRetainedSources: true,
    };
    const result = { ...makeResult(run), session };

    expect(await store.claimSavedResult(observed, result)).toBe('claimed');
    expect(await store.claimSavedResult(observed, result)).toBe('duplicate');
    const answerTs = nextTimestamp();
    expect(await store.completePublication(run, answerTs)).toBe(true);
    expect(
      await store.getPublishedAnswer(answerRef(run, answerTs)),
    ).toMatchObject({
      runId: run.runId,
      result: { session },
    });

    const next = await store.admit(
      makeRun({
        conversationId: run.conversationId,
        threadTs: run.threadTs,
        messageTs: nextTimestamp(),
      }),
    );
    expect(next.outcome).toBe('accepted');
    expect(next.run.session).toEqual(session);
  });

  it('reconciles an expired run without a dispatch target', async () => {
    const session: WorkerSession = {
      seedRunId: randomUUID(),
      nativeId: randomUUID(),
      adapterId: randomUUID(),
      revision: 2,
      hasRetainedSources: true,
    };
    const controlled = await admitControlledRun({
      deadline: Date.now() - 1,
      session,
    });
    expect(await store.interruptRun(controlled, Date.now())).toBe(true);
    expect((await store.getRun(controlled.runId))?.state).toBe('interrupted');
  });

  it('requires a restored-session proof to release an expired bound resumed run', async () => {
    const run = await admitControlledRun({
      deadline: Date.now() - 1,
      session: {
        seedRunId: randomUUID(),
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 4,
      },
    });
    expect(await recordReadyDispatch(store, makeJob(run), makeTarget())).toBe(
      'recorded',
    );
    const observed = (await store.getRun(run.runId))!;
    expect(await store.interruptRun(observed, Date.now())).toBe(false);
    expect(await store.interruptRun(observed, Date.now(), true)).toBe(true);
    expect(await store.getRun(run.runId)).toMatchObject({
      state: 'interrupted',
      session: run.session,
    });
  });

  it('records ordered thumbs additions and removals only on final work answers', async () => {
    const run = await admitControlledRun();
    const result = makeResult(run);
    expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
      'claimed',
    );
    const messageId = nextTimestamp();
    expect(await store.completePublication(run, messageId)).toBe(true);
    const reference = answerRef(run, messageId);
    expect((await store.getPublishedAnswer(reference))?.runId).toBe(run.runId);

    expect(
      await store.recordFeedback(
        reference,
        'U_REACTOR',
        'thumbsup',
        'added',
        '1900000000.000002',
      ),
    ).toBe('recorded');
    expect(
      await store.recordFeedback(
        reference,
        'U_REACTOR',
        'thumbsup',
        'added',
        '1900000000.000002',
      ),
    ).toBe('duplicate');
    expect(
      await store.recordFeedback(
        reference,
        'U_REACTOR',
        'thumbsup',
        'removed',
        '1900000000.000001',
      ),
    ).toBe('stale');
    expect(
      await store.recordFeedback(
        reference,
        'U_REACTOR',
        'thumbsup',
        'removed',
        '1900000000.000003',
      ),
    ).toBe('recorded');
    expect(
      await store.recordFeedback(
        reference,
        'U_REACTOR',
        'thumbsdown',
        'added',
        '1900000000.000004',
      ),
    ).toBe('recorded');
    expect(await store.getRun(run.runId)).toMatchObject({
      feedback: {
        U_REACTOR: {
          thumbsup: {
            active: false,
            eventTs: '1900000000.000003',
          },
          thumbsdown: {
            active: true,
            eventTs: '1900000000.000004',
          },
        },
      },
    });

    expect(
      await store.recordFeedback(
        { ...reference, messageId: nextTimestamp() },
        'U_REACTOR',
        'thumbsup',
        'added',
        '1900000000.000005',
      ),
    ).toBe('conflict');
  });

  it('does not index busy or failed bot publications as feedback answers', async () => {
    const owner = await admitControlledRun();
    const busy = makeRun({
      threadTs: owner.threadTs,
      messageTs: nextTimestamp(),
    });
    const busyRun = (await store.admit(busy)).run;
    const busyResult = makeResult(busyRun);
    expect(
      await store.claimPublication(busyRun.runId, busyResult, Date.now()),
    ).toBe('claimed');
    const busyMessageId = nextTimestamp();
    expect(await store.completePublication(busyRun, busyMessageId)).toBe(true);
    expect(
      await store.getPublishedAnswer(answerRef(busyRun, busyMessageId)),
    ).toBeNull();

    const failed = await admitControlledRun();
    const failedResult: WorkerResult = {
      ...makeResult(failed),
      type: 'failed',
    };
    expect(
      await store.claimPublication(failed.runId, failedResult, Date.now()),
    ).toBe('claimed');
    const failedMessageId = nextTimestamp();
    expect(await store.completePublication(failed, failedMessageId)).toBe(true);
    expect(
      await store.getPublishedAnswer(answerRef(failed, failedMessageId)),
    ).toBeNull();
  });

  async function admitControlledRun(
    overrides: Partial<RunRecord> = {},
  ): Promise<RunRecord> {
    const candidate = makeRun(overrides);
    expect((await store.admit(candidate)).outcome).toBe('accepted');
    expect(await store.claimStatusCreation(candidate.runId)).toBe(true);
    expect(
      await store.recordStatusMessage(candidate.runId, candidate.messageTs),
    ).toBe(true);
    return (await store.getRun(candidate.runId))!;
  }
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

function controlRef(run: RunRecord) {
  return {
    runId: run.runId,
    generation: run.generation,
    statusMessageId: run.statusMessageId!,
  };
}

function answerRef(run: RunRecord, messageId: string): AnswerRef {
  return {
    workspaceId: run.workspaceId,
    channelId: run.channelId,
    messageId,
  };
}

// Production records a dispatch only for an enrolled session that the managed
// runtime marks ready.
async function recordReadyDispatch(
  store: RedisRunStore,
  job: WorkerJob,
  target: SandboxTarget,
) {
  await store.enrollIdleSession(target);
  await store.compareManagedRuntime(
    target.sandboxName,
    await store.getManagedRuntime(target.sandboxName),
    { phase: 'ready', sessionId: target.sessionId, driveId: 'synthetic-drive' },
  );
  return store.recordDispatchTarget(job, target);
}
