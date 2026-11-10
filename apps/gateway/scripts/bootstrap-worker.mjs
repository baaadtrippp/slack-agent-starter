import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Drive, Sandbox, Snapshot } from '@vercel/sandbox';
import { createClient } from 'redis';
import { createManagedWorker } from '../src/managed-worker.ts';
import { RedisRunStore } from '../src/store.ts';

const root = resolve(import.meta.dirname, '../../..');
const workerDir = '/tmp/hydra-worker';
const files = ['run.mjs', 'supervise.mjs', 'control.mjs', 'shared-notes.mjs'];
const packages = [
  'acpx@0.21.1',
  'pi-acp@0.0.34',
  '@earendil-works/pi-coding-agent@1.5.0',
];
const driveSize = 1024 ** 3;
const deny = [
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
];
const signal = (ms = 15_000) => AbortSignal.timeout(ms);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
let phase = 'checking inputs';

class SetupError extends Error {}

function check(condition, message) {
  if (!condition) throw new SetupError(message);
}

function required(name) {
  const value = process.env[name];
  check(value, 'Missing ' + name);
  return value;
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function vercelIdentity() {
  const projectId = required('VERCEL_PROJECT_ID');
  const token = required('VERCEL_OIDC_TOKEN');
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    );
  } catch {
    throw new SetupError('Pull a fresh Vercel project OIDC token.');
  }
  check(
    claims?.project_id === projectId &&
      typeof claims.owner_id === 'string' &&
      ['development', 'production'].includes(claims.environment) &&
      claims.exp * 1000 > Date.now(),
    'The OIDC token must be current and belong to the specified Vercel project.',
  );
  return { token, projectId, teamId: claims.owner_id };
}

function settings() {
  check(
    !git('status', '--porcelain', '--untracked-files=no').length,
    'Commit or revert tracked changes before building a startup seed.',
  );
  const gateway = required('GATEWAY_ORIGIN');
  const origin = URL.parse(gateway);
  check(
    origin?.protocol === 'https:' &&
      (gateway === origin.origin || gateway === origin.origin + '/') &&
      !origin.port &&
      origin.hostname.includes('.') &&
      !isIP(origin.hostname) &&
      origin.hostname !== 'openrouter.ai',
    'GATEWAY_ORIGIN must be the bare public HTTPS gateway origin on port 443.',
  );
  const region = process.env.SANDBOX_REGION || 'iad1';
  check(/^[a-z]{3}\d$/.test(region), 'Invalid SANDBOX_REGION.');
  const redis = URL.parse(required('REDIS_URL'));
  check(
    redis?.protocol === 'rediss:' &&
      redis.password &&
      !redis.search &&
      !redis.hash,
    'Use a dedicated Redis database with a rediss:// connection URL.',
  );
  const model = required('OPENROUTER_MODEL');
  check(
    /^[a-z0-9][a-z0-9._:/-]{1,127}$/i.test(model),
    'Invalid OPENROUTER_MODEL.',
  );
  return {
    revision: git('rev-parse', 'HEAD').toString().trim(),
    origin: origin.origin,
    region,
    redisEndpoint: redis.host + redis.pathname,
    model,
  };
}

async function loadRecord(file, binding, create) {
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    state = {
      ...binding,
      prefix: 'slack-v1-' + randomBytes(12).toString('hex'),
    };
    await writeFile(file, JSON.stringify(state) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  check(
    /^slack-v1-[a-f0-9]{24}$/.test(state?.prefix) &&
      Object.entries(binding).every(([key, value]) => state[key] === value),
    'The worker record belongs to a different checkout, project, or configuration.',
  );
  check(
    !create || !state.retiring,
    'Use a new worker record after starting cleanup.',
  );
  return state;
}

async function saveRecord(file, state) {
  const temporary = file + '.' + randomBytes(6).toString('hex');
  await writeFile(temporary, JSON.stringify(state) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function lookup(operation) {
  try {
    return await operation();
  } catch (error) {
    if ((error?.status ?? error?.statusCode ?? error?.response?.status) !== 404)
      throw error;
  }
}

function resources(state, identity) {
  const seedName = state.prefix + '-seed';
  const sandboxName = state.prefix + '-worker';
  const driveName = state.prefix + '-drive';
  const options = { ...identity, signal: signal() };
  const assertSandbox = (sandbox) => {
    const seed = sandbox.name === seedName;
    check(
      (seed || sandbox.name === sandboxName) &&
        sandbox.tags?.bootstrap === state.prefix &&
        !sandbox.persistent &&
        sandbox.region === state.region &&
        Object.keys(sandbox.mounts ?? {}).length === (seed ? 0 : 1),
      'Unexpected Sandbox configuration.',
    );
    return sandbox;
  };
  const assertDrive = (drive) => {
    check(
      drive.name === driveName &&
        drive.projectId === state.projectId &&
        drive.region === state.region &&
        drive.maxSize === driveSize &&
        (!state.driveId || drive.driveId === state.driveId),
      'Unexpected Drive configuration.',
    );
    return drive;
  };
  return {
    seedName,
    sandboxName,
    driveName,
    assertSandbox,
    assertDrive,
    sandbox: (name) =>
      lookup(() =>
        Sandbox.get({ ...options, signal: signal(), name, resume: false }),
      ),
    drive: () =>
      lookup(() =>
        Drive.get({ ...options, signal: signal(), name: driveName }),
      ),
    snapshot: (snapshotId) =>
      lookup(() => Snapshot.get({ ...options, signal: signal(), snapshotId })),
  };
}

async function command(session, cmd, args, timeoutMs = 10_000, sudo = false) {
  const result = await session.runCommand({
    cmd,
    args,
    timeoutMs,
    sudo,
    signal: signal(timeoutMs + 10_000),
  });
  check(
    result.exitCode === 0,
    'Sandbox command failed: ' + cmd + '. Inspect the command in Vercel.',
  );
  return result;
}

const parserSetup = [
  'set -eu',
  'if ! test -x /usr/bin/pdftotext || ! test -x /usr/bin/prlimit || ! command -v setpriv >/dev/null || ! command -v flock >/dev/null; then',
  '  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*; do',
  '    if test -f "$file"; then',
  '      sed -Ei \'s#http://(archive[.]ubuntu[.]com|security[.]ubuntu[.]com|deb[.]debian[.]org)/#https://\\1/#g\' "$file"',
  '    fi',
  '  done',
  '  apt-get -o Acquire::Retries=2 update',
  '  apt-get install -y --no-install-recommends poppler-utils util-linux',
  'fi',
].join('\n');

async function verifyAssets(session, source) {
  await command(session, 'bash', [
    '-ec',
    [
      'cd /tmp/hydra-worker',
      'test -x node_modules/.bin/pi && test -x node_modules/.bin/pi-acp && test -x node_modules/.bin/acpx',
      'test -x /usr/bin/pdftotext && test -x /usr/bin/prlimit && command -v flock && command -v setpriv && command -v sysctl',
      ...files.map((name) => 'node --check ' + name),
    ].join('\n'),
  ]);
  const result = await command(
    session,
    'sha256sum',
    source.map(({ path }) => path),
  );
  const hashes = (await result.stdout({ signal: signal() })).trim().split('\n');
  check(
    source.every(
      ({ content }, index) => hashes[index]?.split(' ')[0] === sha256(content),
    ),
    'The Sandbox worker files do not match the committed source.',
  );
}

async function setup(file, state, identity, key) {
  const provider = resources(state, identity);
  const { seedName, sandboxName, driveName } = provider;
  const options = {
    ...identity,
    region: state.region,
    failoverRegions: [],
    persistent: false,
    resources: { vcpus: 1 },
    timeout: 1_500_000,
    tags: { bootstrap: state.prefix },
  };
  const source = files.map((name) => ({
    path: workerDir + '/' + name,
    content: git('show', state.revision + ':apps/worker/sandbox/' + name),
    mode: 0o600,
  }));

  phase = 'preparing the startup seed';
  const seed = provider.assertSandbox(
    (await provider.sandbox(seedName)) ??
      (await Sandbox.create({
        ...options,
        name: seedName,
        image: 'vercel/sandbox/node:24',
        signal: signal(45_000),
        networkPolicy: {
          allow: [
            'registry.npmjs.org',
            'archive.ubuntu.com',
            'security.ubuntu.com',
            'deb.debian.org',
          ],
        },
      })),
  );
  const seedSession = seed.currentSession();
  let seedId = seed.currentSnapshotId;
  check(
    !state.seedId || state.seedId === seedId,
    'The recorded startup snapshot changed or expired.',
  );
  if (!seedId) {
    check(
      seedSession.status === 'running',
      'Wait for the seed if it is starting or snapshotting. If it stopped without a snapshot, clean up and use a new record.',
    );
    if (seed.networkPolicy !== 'deny-all') {
      await command(seedSession, 'bash', ['-c', parserSetup], 150_000, true);
      await command(seedSession, 'mkdir', ['-p', '-m', '700', workerDir]);
      await command(
        seedSession,
        'npm',
        [
          'install',
          '--prefix',
          workerDir,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--save-exact',
          ...packages,
        ],
        120_000,
      );
      await seedSession.writeFiles(source, { signal: signal() });
      await verifyAssets(seedSession, source);
      // Keep build egress and model credentials out of the startup snapshot.
      await seed.update({ networkPolicy: 'deny-all' }, { signal: signal() });
    }
    seedId = (
      await seedSession.snapshot({ expiration: 0, signal: signal(90_000) })
    ).snapshotId;
  }
  const sealedSeed = await provider.sandbox(seedName);
  check(
    sealedSeed?.networkPolicy === 'deny-all' &&
      sealedSeed.currentSnapshotId === seedId,
    'The startup seed must be sealed with deny-all egress.',
  );
  const snapshot = await provider.snapshot(seedId);
  check(
    snapshot?.status === 'created' &&
      snapshot.sourceSessionId === seedSession.sessionId,
    'The exact startup snapshot is unavailable.',
  );
  state.seedId = seedId;
  await saveRecord(file, state);

  phase = 'verifying the single writable Drive and worker';
  const drive = provider.assertDrive(
    (await provider.drive()) ??
      (await Drive.getOrCreate({
        ...identity,
        name: driveName,
        region: state.region,
        maxSize: driveSize,
        signal: signal(25_000),
      })),
  );
  state.driveId = drive.driveId;
  await saveRecord(file, state);

  const hostname = new URL(state.origin).hostname;
  let worker = await provider.sandbox(sandboxName);
  if (!worker) {
    check(
      !drive.currentSessionId && !drive.currentSandboxName,
      'The Drive already has a writable attachment.',
    );
    worker = await Sandbox.fork({
      ...options,
      name: sandboxName,
      sourceSandbox: seedName,
      mounts: { '/workspace': drive },
      networkPolicy: {
        allow: {
          [hostname]: [],
          'openrouter.ai': [
            { transform: [{ headers: { Authorization: 'Bearer ' + key } }] },
          ],
        },
        subnets: { deny },
      },
      signal: signal(45_000),
    });
  }
  provider.assertSandbox(worker);
  const policy = worker.networkPolicy;
  const allowedHosts = Array.isArray(policy?.allow)
    ? policy.allow
    : Object.keys(policy?.allow ?? {});
  // Provider readback can omit credential rules altogether.
  check(
    allowedHosts.length === 2 &&
      allowedHosts.includes(hostname) &&
      allowedHosts.includes('openrouter.ai') &&
      !policy.subnets?.allow?.length &&
      deny.every((range) => policy.subnets?.deny?.includes(range)),
    'The worker egress allowlist does not match.',
  );
  let session = worker.currentSession();
  check(
    worker.currentSnapshotId === seedId &&
      session.sourceSnapshotId === seedId &&
      worker.mounts?.['/workspace']?.drive === driveName &&
      worker.mounts['/workspace'].mode === 'read-write',
    'The worker does not use the exact startup snapshot and writable Drive.',
  );

  phase = 'enrolling the exact session in Redis';
  const client = createClient({
    url: required('REDIS_URL'),
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  client.on('error', () => {});
  try {
    const store = new RedisRunStore(client);
    const runtime = await store.getManagedRuntime(sandboxName);
    if (!runtime) {
      let attached = provider.assertDrive(await provider.drive());
      if (session.status === 'stopped') {
        check(
          !attached.currentSessionId && !attached.currentSandboxName,
          'Wait for the stopped session to release the Drive, then retry.',
        );
        worker = await Sandbox.get({
          ...identity,
          name: sandboxName,
          resume: true,
          signal: signal(45_000),
        });
        session = worker.currentSession();
        attached = provider.assertDrive(await provider.drive());
      }
      check(
        session.status === 'running' &&
          session.sourceSnapshotId === seedId &&
          attached.currentSessionId === session.sessionId &&
          attached.currentSandboxName === sandboxName,
        'The exact worker session does not hold the Drive mount.',
      );
      check(
        await store.enrollIdleSession({
          sandboxName,
          sessionId: session.sessionId,
        }),
        'Could not enroll the prepared worker session.',
      );
    }

    const managed = createManagedWorker(
      { sandboxName, driveName, seedId, controlsEnabled: true },
      store,
    );
    const ready = await managed.getSession(Date.now() + 25_000);
    const attached = provider.assertDrive(await provider.drive());
    check(
      ready?.status === 'running' &&
        ready.sourceSnapshotId === seedId &&
        (!runtime
          ? ready.sessionId === session.sessionId
          : runtime.driveId === attached.driveId) &&
        attached.currentSessionId === ready.sessionId &&
        attached.currentSandboxName === sandboxName,
      'Managed worker readiness failed. Retry setup before enabling Slack traffic.',
    );
    await verifyAssets(ready, source);
  } finally {
    if (client.isOpen) client.destroy();
  }

  console.log('SANDBOX_WORKER_NAME=' + sandboxName);
  console.log('SANDBOX_MANAGED_DRIVE=' + driveName);
  console.log('SANDBOX_MANAGED_SEED=' + seedId);
}

async function cleanup(file, state, identity) {
  phase = 'retiring the recorded worker resources';
  state.retiring = true;
  await saveRecord(file, state);
  const provider = resources(state, identity);
  for (const name of [provider.sandboxName, provider.seedName]) {
    const sandbox = await provider.sandbox(name);
    if (!sandbox) continue;
    provider.assertSandbox(sandbox);
    if (name === provider.seedName && sandbox.currentSnapshotId) {
      check(
        !state.seedId || state.seedId === sandbox.currentSnapshotId,
        'The startup snapshot has changed.',
      );
      state.seedId = sandbox.currentSnapshotId;
      await saveRecord(file, state);
    }
    if (sandbox.status === 'running')
      await sandbox.currentSession().stop({ signal: signal(35_000) });
    await lookup(() => sandbox.delete({ signal: signal(35_000) }));
    check(
      !(await provider.sandbox(name)),
      'A Sandbox is still visible. Retry cleanup.',
    );
  }

  for (let attempt = 0; ; attempt += 1) {
    const drive = await provider.drive();
    if (!drive) break;
    provider.assertDrive(drive);
    if (!drive.currentSessionId && !drive.currentSandboxName)
      await lookup(() => drive.delete({ signal: signal(35_000) }));
    check(
      attempt < 19,
      'The Drive remains visible or attached. Retry cleanup.',
    );
    await delay(750);
  }
  if (state.seedId) {
    const snapshot = await provider.snapshot(state.seedId);
    if (snapshot && snapshot.status !== 'deleted')
      await lookup(() => snapshot.delete({ signal: signal(35_000) }));
    const remaining = await provider.snapshot(state.seedId);
    check(
      !remaining || remaining.status === 'deleted',
      'The startup snapshot is still visible. Retry cleanup.',
    );
  }
  console.log(
    'Verified removal of the recorded Sandboxes, Drive, and startup snapshot.',
  );
}

try {
  const [action, recordPath, ...extra] = process.argv.slice(2);
  check(
    ['setup', 'cleanup'].includes(action) && recordPath && !extra.length,
    'Usage: node apps/gateway/scripts/bootstrap-worker.mjs setup|cleanup WORKER_RECORD',
  );
  const file = resolve(recordPath);
  const fromRepo = relative(root, file);
  check(
    fromRepo.startsWith('..' + sep) || isAbsolute(fromRepo),
    'Keep the worker record outside the checkout.',
  );
  const identity = vercelIdentity();
  const { projectId, teamId } = identity;
  if (action === 'setup') {
    const key = required('OPENROUTER_API_KEY');
    check(
      /^sk-or-v1-[a-f0-9]+$/.test(key),
      'Provide a scoped OpenRouter API key.',
    );
    const state = await loadRecord(
      file,
      { projectId, teamId, ...settings(), modelKeyDigest: sha256(key) },
      true,
    );
    await setup(file, state, identity, key);
  } else {
    await cleanup(
      file,
      await loadRecord(file, { projectId, teamId }, false),
      identity,
    );
  }
} catch (error) {
  console.error(
    error instanceof SetupError
      ? error.message
      : 'Worker bootstrap failed while ' +
          phase +
          '. Keep the record and retry or clean up.',
  );
  process.exitCode = 1;
}
