import { createRedisState } from '@chat-adapter/state-redis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import type {
  WorkerJob,
  WorkerResult,
} from '../packages/contracts/src/index.js';
import {
  RedisRunStore,
  type RunRecord,
  type SandboxTarget,
} from '../apps/gateway/src/store.js';

export const redisUrl = process.env.TEST_REDIS_URL;

// Call inside a describe block: connects before its tests and deletes its keys
// afterwards.
export function useRedisStore() {
  const namespace = `slack-agent:test:${randomUUID()}`;
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
    for await (const keys of client.scanIterator({ MATCH: `${namespace}:*` })) {
      if (keys.length > 0) await client.del(keys);
    }
    await state.disconnect();
  });

  return { namespace, state, store };
}

let timestampCounter = 0;

export function nextTimestamp(): string {
  timestampCounter += 1;
  return `${1_900_000_000 + timestampCounter}.000001`;
}

export function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
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

export function makeTarget(label: string = randomUUID()): SandboxTarget {
  return { sandboxName: `synthetic-${label}`, sessionId: randomUUID() };
}

export function makeJob(run: RunRecord): WorkerJob {
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

export function makeResult(run: RunRecord): WorkerResult {
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

// Production records a dispatch only for an enrolled session that the managed
// runtime marks ready.
export async function recordReadyDispatch(
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
