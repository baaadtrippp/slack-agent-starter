import { randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { createClient } from 'redis';
import { RedisRunStore } from '../src/store.ts';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function coordinate(action, expectedSessionId, sandboxName, store) {
  const readSandbox = () =>
    Sandbox.get({
      name: sandboxName,
      resume: false,
      signal: AbortSignal.timeout(10_000),
    });
  const sandbox = await readSandbox();
  const session = sandbox.currentSession();
  if (sandbox.persistent || session.sessionId !== expectedSessionId)
    return fail('Expected the exact prepared nonpersistent worker session.');

  const target = { sandboxName, sessionId: expectedSessionId };
  if (action === 'enroll') {
    if (
      session.status !== 'running' ||
      !(await store.enrollIdleSession(target))
    )
      return fail('Could not enroll the prepared worker session.');
    console.log('Prepared worker session enrolled for coordinated idle stop.');
    return;
  }

  if (session.status === 'stopped') {
    console.log('The exact worker session is stopped.');
    return;
  }
  if (session.status !== 'running')
    return fail('The exact worker session is not ready for an idle stop.');

  const operationId = randomUUID();
  const claim = await store
    .claimIdleStop(target, operationId)
    .catch(() => store.claimIdleStop(target, operationId));
  if (claim === 'active')
    return fail('Work is still reserved on this session.');
  if (claim !== 'claimed' && claim !== 'stopping')
    return fail('Enroll the exact session before requesting its idle stop.');

  // A retry targets the same fenced session even if its earlier stop was uncertain.
  await session.stop({ signal: AbortSignal.timeout(35_000) }).catch(() => {});
  const observed = (await readSandbox()).currentSession();
  if (observed.sessionId !== expectedSessionId || observed.status !== 'stopped')
    return fail('Stop was not confirmed. The dispatch fence remains in place.');
  console.log(
    'The exact worker session stopped. Verify Drive detachment before replacement.',
  );
}

const [action, sessionId, ...rest] = process.argv.slice(2);
const { SANDBOX_WORKER_NAME: sandboxName, REDIS_URL: redisUrl } = process.env;
if (
  (action !== 'enroll' && action !== 'stop') ||
  !sessionId ||
  rest.length ||
  !sandboxName ||
  !redisUrl
) {
  fail(
    'Provide enroll or stop, the exact session ID, and the gateway worker and Redis settings.',
  );
} else {
  let client;
  try {
    const url = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(url.protocol) || url.hash)
      throw new Error('Invalid Redis URL');
    client = createClient({
      url: url.toString(),
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
      disableOfflineQueue: true,
    });
    client.on('error', () => {});
    await coordinate(action, sessionId, sandboxName, new RedisRunStore(client));
  } catch {
    fail(
      'Could not verify idle shutdown state. Inspect the exact worker session before retrying.',
    );
  } finally {
    if (client?.isOpen) client.destroy();
  }
}
