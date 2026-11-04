import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  WorkerJob,
  WorkerResult,
} from '../packages/contracts/src/index.js';
import {
  RedisRunStore,
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
    expect(bound.sort()).toEqual([false, true]);

    const saved = await store.getRun(run.runId);
    expect(targets).toContainEqual(saved?.execution);
    expect(
      await store.recordDispatchTarget(makeJob(run), {
        sandboxName: 'synthetic-c',
        sessionId: randomUUID(),
      }),
    ).toBe(false);

    const busy = makeRun({
      threadTs: run.threadTs,
      messageTs: nextTimestamp(),
    });
    expect((await store.admit(busy)).outcome).toBe('busy');
    expect(await store.recordDispatchTarget(makeJob(busy), targets[0]!)).toBe(
      false,
    );
  });

  it('claims a callback once and releases only its own thread lease on completion', async () => {
    const run = makeRun();
    await store.admit(run);
    const result = makeResult(run);

    expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
      'claimed',
    );
    expect(await store.claimPublication(run.runId, result, Date.now())).toBe(
      'duplicate',
    );
    expect(await store.completePublication(run, '1700000002.000003')).toBe(
      true,
    );

    const next = await store.admit(
      makeRun({
        threadTs: run.threadTs,
        messageTs: '1700000003.000004',
      }),
    );
    expect(next.outcome).toBe('accepted');
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

  it('interrupts only an expired bound owner and preserves its evidence', async () => {
    const run = makeRun();
    const target = {
      sandboxName: 'synthetic-interrupted',
      sessionId: randomUUID(),
    };
    await store.admit(run);
    expect(await store.recordDispatchTarget(makeJob(run), target)).toBe(true);
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
