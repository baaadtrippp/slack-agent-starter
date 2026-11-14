import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv } from 'node:util';
import { createClient } from 'redis';
import {
  createManagedWorker,
  MANAGED_WORKER_LAUNCH,
} from '../src/managed-worker.ts';
import { RedisRunStore } from '../src/store.ts';

const fixtureDir = '/tmp/check-worker';
const statePath = fixtureDir + '/state.json';
const signal = (ms = 20_000) => AbortSignal.timeout(ms);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const { values, positionals } = parseArgs({
  options: { paid: { type: 'boolean', default: false } },
  allowPositionals: true,
});
const [recordArg, ...extra] = positionals;
assert.ok(
  recordArg && !extra.length,
  'Usage: node apps/gateway/scripts/check-worker.mjs [--paid] CHECK_RECORD',
);
const record = resolve(recordArg);
assert.ok(!existsSync(record), 'Use a new CHECK_RECORD path.');

function bootstrap(action) {
  const script = join(import.meta.dirname, 'bootstrap-worker.mjs');
  return execFileSync(process.execPath, [script, action, record], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// A throwaway certificate for the loopback stand-ins, read into memory before
// its private temporary directory is removed.
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'check-worker-'));
  const args =
    'req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=openrouter.ai -addext subjectAltName=DNS:openrouter.ai,IP:127.0.0.1 -keyout key.pem -out cert.pem';
  try {
    execFileSync('openssl', args.split(' '), { cwd: dir, stdio: 'ignore' });
    return ['cert.pem', 'key.pem'].map((name) => readFileSync(join(dir, name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const [cert, key] = certificate();
const client = createClient({
  url: process.env.REDIS_URL,
  socket: { connectTimeout: 5_000, reconnectStrategy: false },
  disableOfflineQueue: true,
});
client.on('error', () => {});

const csvMarker = randomBytes(8).toString('hex');
const csv = 'region,units\nnorth,' + csvMarker + '\n';
const artifact = 'checked,' + csvMarker + '\n';
const job = () => ({
  version: 1,
  runId: randomUUID(),
  generation: 1,
  callbackUrl: 'https://127.0.0.1:8443/api/worker/callback',
  callbackToken: randomBytes(32).toString('hex'),
  artifactOutput: true,
});
const first = job();
first.input = {
  text: 'Check turn one ' + first.runId,
  sources: [{ kind: 'csv', name: 'check.csv', sha256: sha256(csv) }],
};
const reply = job();
reply.input = { text: 'Check turn two ' + reply.runId };
const stopped = job();
stopped.input = { text: 'Check stop ' + stopped.runId };
const paidMarker = randomBytes(8).toString('hex');
const paid = job();
paid.input = { text: 'Reply with this exact code only: ' + paidMarker };
const config = {
  first: first.runId,
  reply: reply.runId,
  stopped: stopped.runId,
  csvMarker,
  artifact,
  tokens: Object.fromEntries(
    [first, reply, stopped, paid].map(({ runId, callbackToken }) => [
      runId,
      callbackToken,
    ]),
  ),
};

async function read(session, path) {
  const bytes = await session.readFileToBuffer({ path }, { signal: signal() });
  return bytes?.toString();
}

// Points openrouter.ai at the loopback stand-in and starts both servers.
async function prepare(session) {
  const fixture = join(import.meta.dirname, 'check-worker-fixture.mjs');
  const files = {
    'fixture.mjs': readFileSync(fixture),
    'cert.pem': cert,
    'key.pem': key,
    'config.json': JSON.stringify(config),
  };
  await session.writeFiles(
    Object.entries(files).map(([name, content]) => ({
      path: fixtureDir + '/' + name,
      content,
      mode: name === 'cert.pem' ? 0o644 : 0o600,
    })),
    { signal: signal() },
  );
  const setup = await session.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      [
        'set -eux',
        'cd ' + fixtureDir,
        // Keep the Sandbox firewall CA that Pi needs for the real provider.
        'cat ${NODE_EXTRA_CA_CERTS:+"$NODE_EXTRA_CA_CERTS"} cert.pem > bundle.pem',
        '{ grep -v "openrouter[.]ai" /etc/hosts; echo "127.0.0.1 openrouter.ai"; } > hosts',
        'chmod 644 bundle.pem hosts',
        'mount --bind hosts /etc/hosts',
        'test "$(getent ahosts openrouter.ai | cut -d" " -f1 | sort -u)" = 127.0.0.1',
        'date +%s%3N',
      ].join('; '),
    ],
    sudo: true,
    signal: signal(),
  });
  const after = Date.now();
  if (setup.exitCode !== 0)
    assert.fail('The stand-in setup failed: ' + (await setup.stderr()));
  // Job deadlines use the local clock. The return delay counts toward 2 s.
  const now = Number(await setup.stdout({ signal: signal() }));
  const synced = Math.abs(after - now) < 2_000;
  assert.ok(synced, 'The local and Sandbox clocks differ by 2 s or more.');
  await session.runCommand({
    cmd: 'node',
    args: ['fixture.mjs', 'config.json', 'state.json'],
    cwd: fixtureDir,
    sudo: true,
    detached: true,
    signal: signal(),
  });
  for (let attempt = 0; !(await read(session, statePath)); attempt += 1) {
    assert.ok(attempt < 40, 'The stand-in servers did not start.');
    await delay(250);
  }
}

// Launches one job the way the gateway does.
function launch(session, job) {
  job.deadline = Date.now() + 60_000;
  return session.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      MANAGED_WORKER_LAUNCH,
      'hydra-worker',
      '/tmp/hydra-worker/supervise.mjs',
    ],
    sudo: true,
    cwd: '/tmp/hydra-worker',
    env: {
      HYDRA_JOB: JSON.stringify(job),
      HYDRA_MODEL: process.env.OPENROUTER_MODEL,
      OPENROUTER_API_KEY: 'sandbox-firewall',
      NODE_EXTRA_CA_CERTS: fixtureDir + '/bundle.pem',
    },
    detached: true,
    timeoutMs: 60_000,
    signal: signal(),
  });
}

// Launches one job and returns its saved result.
async function run(session, job) {
  const command = await launch(session, job);
  const finished = await command.wait({ signal: signal(70_000) });
  const path = '/workspace/runs/' + job.runId + '/result.json';
  const result = JSON.parse((await read(session, path)) ?? 'null');
  const state = JSON.parse(await read(session, statePath));
  const { callbacks, models, errors } = state;
  if (finished.exitCode !== 0 || result?.type !== 'completed')
    assert.fail('Run failed: ' + (await finished.stderr()) + errors.join());
  assert.deepEqual(errors, []);
  if (job !== paid)
    assert.ok(models.includes(job.runId), 'The stand-in model was not used.');
  const done = callbacks.filter(
    (callback) => callback.runId === job.runId && callback.type !== 'working',
  );
  assert.deepEqual(done, [{ runId: job.runId, type: 'completed' }]);
  return result;
}

// Once the job and the reply both wait on the stand-in model, sends the
// gateway's Stop request for the job. The stand-in holds the reply until the
// stopped run's model request closes.
async function stop(session, job) {
  await launch(session, job);
  for (let attempt = 0; ; attempt += 1) {
    const { models } = JSON.parse(await read(session, statePath));
    if (models.includes(job.runId) && models.includes(reply.runId)) break;
    assert.ok(attempt < 120, 'The runs did not reach the stand-in model.');
    await delay(250);
  }
  // The control request that inspectSandboxRun sends for Stop.
  const control = await session.runCommand({
    cmd: 'node',
    args: ['/tmp/hydra-worker/control.mjs'],
    cwd: '/tmp/hydra-worker',
    env: {
      HYDRA_CONTROL: JSON.stringify({
        version: 1,
        runId: job.runId,
        generation: job.generation,
        action: 'cancel',
      }),
    },
    timeoutMs: 15_000,
    signal: signal(),
  });
  assert.equal(control.exitCode, 0, 'The Stop request failed.');
  // The gateway confirms this proof as stopped for a run without a session.
  assert.partialDeepStrictEqual(
    JSON.parse(await control.stdout({ signal: signal() })),
    {
      version: 1,
      runId: job.runId,
      generation: job.generation,
      state: 'exited',
      processesExited: true,
      stopRequested: true,
      sessionSafe: 'uncommitted',
    },
  );
  const { callbacks } = JSON.parse(await read(session, statePath));
  const done = callbacks.filter(
    (callback) => callback.runId === job.runId && callback.type !== 'working',
  );
  assert.deepEqual(done, [], 'The stopped run answered.');
}

try {
  const settings = parseEnv(bootstrap('setup'));
  const { revision } = JSON.parse(readFileSync(record, 'utf8'));
  console.log('Tested commit: ' + revision);
  await client.connect();
  const managed = createManagedWorker(
    {
      sandboxName: settings.SANDBOX_WORKER_NAME,
      driveName: settings.SANDBOX_MANAGED_DRIVE,
      seedId: settings.SANDBOX_MANAGED_SEED,
    },
    new RedisRunStore(client),
  );

  const session = await managed.getSession(Date.now() + 25_000);
  assert.equal(session?.status, 'running', 'No ready worker session.');
  await prepare(session);
  const inputs = '/workspace/inputs/' + first.runId + '/' + first.runId;
  await session.writeFiles(
    [{ path: inputs + '/input-0', content: csv, mode: 0o600 }],
    { signal: signal() },
  );
  const firstResult = await run(session, first);

  // Stop the session as the gateway does after a run; the next getSession
  // resumes the Sandbox from the startup snapshot on the same Drive.
  await managed.stopIfIdle(session);
  let resumed;
  for (let attempt = 0; !resumed; attempt += 1) {
    assert.ok(attempt < 60, 'The worker did not resume.');
    await delay(1_000);
    resumed = await managed.getSession(Date.now() + 25_000).catch(() => {});
  }
  assert.notEqual(resumed.sessionId, session.sessionId);

  await prepare(resumed);
  reply.session = firstResult.session;
  const [replyResult] = await Promise.all([
    run(resumed, reply),
    stop(resumed, stopped),
  ]);
  for (const key of ['seedRunId', 'nativeId', 'adapterId'])
    assert.equal(replyResult.session?.[key], firstResult.session[key]);
  assert.ok(replyResult.session.revision > firstResult.session.revision);
  assert.equal(replyResult.artifact?.sha256, sha256(artifact));
  const path = '/workspace/runs/' + reply.runId + '/results/result.csv';
  assert.equal(await read(resumed, path), artifact);
  if (values.paid) {
    // Remove the stand-in override so the next run reaches the real host.
    const restore = await resumed.runCommand({
      cmd: 'bash',
      args: [
        '-c',
        'umount /etc/hosts && getent ahosts openrouter.ai | grep -qv "^127[.]"',
      ],
      sudo: true,
      signal: signal(),
    });
    assert.equal(restore.exitCode, 0, 'openrouter.ai is still overridden.');
    const paidResult = await run(resumed, paid);
    assert.ok(paidResult.text.includes(paidMarker), 'The paid answer differs.');
    console.log('Paid OpenRouter turn passed.');
  }
  console.log('Worker check passed.');
} catch (error) {
  console.error('Worker check failed: ' + (error?.message ?? error));
  process.exitCode = 1;
} finally {
  const prefix =
    existsSync(record) && JSON.parse(readFileSync(record, 'utf8')).prefix;
  try {
    if (prefix) process.stdout.write(bootstrap('cleanup'));
  } finally {
    // Remove only this check worker's managed-runtime and idle records.
    if (/^slack-v1-[a-f0-9]{24}$/.test(prefix)) {
      if (!client.isOpen) await client.connect();
      for (const kind of ['runtime', 'idle'])
        for await (const keys of client.scanIterator({
          MATCH: `slack-agent:m1:${kind}:${prefix}-worker:*`,
          COUNT: 1000,
        }))
          if (keys.length) await client.del(keys);
    }
    if (client.isOpen) client.destroy();
  }
}
