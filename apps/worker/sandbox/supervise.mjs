import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
  constants,
  mkdir,
  open,
  realpath,
  readdir,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createExclusiveJson,
  hasRunMarker,
  markedProcess,
  parseProcessIdentity,
  processIdentity,
  readControlRecord,
  readRegularJson,
  signalExact,
  writeSyncedAtomic,
} from './control.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const checksum = /^[0-9a-f]{64}$/;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await supervise(JSON.parse(process.env.HYDRA_JOB ?? 'null'));
  } catch {
    console.error('Sandbox worker supervision failed');
    process.exitCode = 1;
  }
}

export async function supervise(
  job,
  {
    controls = '/tmp/hydra-worker-control',
    workspace = '/workspace',
    worker = join(import.meta.dirname, 'run.mjs'),
    ready = sendReady,
    readIdentity = processIdentity,
    proveGroup = proveExactGroup,
    descendantGraceMs = 2_000,
    cooperativeGraceMs = 4_000,
  } = {},
) {
  if (
    job?.version !== 1 ||
    !uuid.test(job.runId) ||
    (job.session !== undefined && !uuid.test(job.session?.seedRunId ?? '')) ||
    !Number.isSafeInteger(job.generation) ||
    job.generation < 1
  )
    throw new Error('Invalid supervised worker job');

  const child = spawn(process.execPath, [worker], {
    detached: true,
    env: { ...process.env, HYDRA_RUN_ID: job.runId },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  if (!child.pid) throw new Error('Worker process did not start');
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let captured;
  try {
    captured = await Promise.race([
      readIdentity(child.pid).then((identity) => ({ identity })),
      closed.then((outcome) => ({ outcome })),
    ]);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return finishSupervision(job, {
      outcome: await closed,
      controls,
      workspace,
      descendantGraceMs,
    });
  }
  if (captured.outcome)
    return finishSupervision(job, {
      outcome: captured.outcome,
      controls,
      workspace,
      descendantGraceMs,
    });
  const identity = captured.identity;
  if (
    identity.state === 'Z' ||
    identity.ppid !== process.pid ||
    identity.pgid !== child.pid ||
    identity.sessionId !== child.pid
  ) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    await closed;
    throw new Error('Worker process group was not isolated');
  }
  const record = {
    version: 1,
    runId: job.runId,
    generation: job.generation,
    controlId: randomUUID(),
    pid: child.pid,
    startTicks: identity.startTicks,
    pgid: identity.pgid,
    sessionId: identity.sessionId,
  };
  try {
    await createExclusiveJson(join(controls, job.runId + '.json'), record);
  } catch (error) {
    await signalExact(record, job.runId, 'SIGTERM');
    await closed;
    throw error;
  }
  const stopMonitor = monitorStop(
    record,
    controls,
    closed,
    job.runId,
    cooperativeGraceMs,
    proveGroup,
  );
  void stopMonitor.catch(() => {
    console.error(
      JSON.stringify({ runId: job.runId, phase: 'worker_fallback_refused' }),
    );
  });
  let readyError;
  try {
    await ready(child, job);
  } catch (error) {
    readyError = error;
  }

  const forward = () => {
    void signalExact(record, job.runId, 'SIGTERM');
  };
  process.once('SIGTERM', forward);
  let outcome;
  try {
    outcome = await closed;
  } finally {
    process.removeListener('SIGTERM', forward);
  }
  const escalation = await stopMonitor.catch(() => ({}));

  return finishSupervision(job, {
    record,
    outcome,
    readyError,
    controls,
    workspace,
    descendantGraceMs,
    escalation,
  });
}

async function finishSupervision(
  job,
  {
    record,
    outcome,
    readyError,
    controls,
    workspace,
    descendantGraceMs,
    escalation,
  },
) {
  const forced = escalation?.forced === true;
  if (
    !(await waitForRunProcessesExit(
      record,
      job.runId,
      descendantGraceMs,
      forced,
    ))
  )
    throw new Error('Worker descendants remain active');
  const stop = record
    ? await readMatchingJson(join(controls, job.runId + '.stop.json'), record)
    : undefined;
  if (readyError)
    console.error(
      JSON.stringify({ runId: job.runId, phase: 'worker_ready_failed' }),
    );
  const runRoot = join(workspace, 'runs', job.runId);
  const result = await readWorkerResult(
    join(runRoot, 'result.json'),
    job.runId,
    job.generation,
  );
  const sessionSafe = stop
    ? await verifyStoppedSessionState(job, result, workspace)
    : await verifySessionState(job, result, workspace);
  if (stop) await removeOwnedScratch(job);
  const exit = {
    version: 1,
    runId: job.runId,
    generation: job.generation,
    state: 'exited',
    stopRequested: Boolean(stop),
    forced,
    processesExited: true,
    ...(forced ? { targetPgid: escalation.targetPgid } : {}),
    sessionSafe,
    ...(result ? { resultType: result.type } : {}),
    exitCode: outcome.code,
    signal: outcome.signal,
  };
  await writeAtomicJson(join(runRoot, 'exit.json'), exit);
  return exit;
}

async function sendReady(child, job) {
  await new Promise((resolve, reject) => {
    child.send(
      {
        version: 1,
        type: 'ready',
        runId: job.runId,
        generation: job.generation,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

async function monitorStop(
  record,
  controls,
  closed,
  runId,
  graceMs,
  proveGroup,
) {
  let childClosed = false;
  void closed.then(
    () => {
      childClosed = true;
    },
    () => {
      childClosed = true;
    },
  );
  while (!childClosed) {
    const stop = await readControlRecord(join(controls, runId + '.stop.json'));
    if (stop) {
      validateMatchingRecord(stop, record);
      await signalExact(record, runId, 'SIGTERM');
      if (await waitForRunProcessesExit(record, runId, graceMs)) return {};
      try {
        proveGroup(record, runId);
        process.kill(-record.pgid, 'SIGKILL');
        return { forced: true, targetPgid: record.pgid };
      } catch (error) {
        if (error?.code !== 'ESRCH')
          console.error(
            JSON.stringify({
              runId,
              phase: 'worker_fallback_refused',
              reason: error?.message,
            }),
          );
        return {};
      }
    }
    await Promise.race([closed, delay(25)]);
  }
  return {};
}

function proveExactGroup(record, runId) {
  verifyExactLeader(record);
  verifyGroupMembership(record, runId, liveProcessSnapshot(record));
  verifyExactLeader(record);
}

function verifyExactLeader(record) {
  const leader = processIdentitySync(record.pid);
  if (
    leader.state === 'Z' ||
    leader.ppid !== process.pid ||
    leader.startTicks !== record.startTicks ||
    leader.pgid !== record.pgid ||
    leader.sessionId !== record.sessionId ||
    leader.pgid !== record.pid ||
    leader.sessionId !== record.pid
  )
    throw new Error('Worker process group identity changed');
}

/** Rejects mixed groups and marked processes outside the registered group. */
export function verifyGroupMembership(record, runId, processes) {
  let leaderMarked = false;
  for (const { pid, pgid, sessionId, environment } of processes) {
    const marked = hasRunMarker(environment, runId);
    const inGroup = pgid === record.pgid && sessionId === record.sessionId;
    if (inGroup && !marked)
      throw new Error('Worker group contains an unmarked process');
    if ((marked || sessionId === record.sessionId) && !inGroup)
      throw new Error('Worker process escaped its isolated group');
    if (pid === record.pid && inGroup && marked) leaderMarked = true;
  }
  if (!leaderMarked) throw new Error('Worker leader marker is missing');
}

function* liveProcessSnapshot(record) {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let identity;
    try {
      identity = processIdentitySync(pid);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
      throw error;
    }
    if (identity.state === 'Z') continue;
    const environment = processEnvironmentSync(
      pid,
      identity.startTicks,
      record,
    );
    yield { ...identity, pid, environment };
  }
}

function processIdentitySync(pid) {
  return parseProcessIdentity(readFileSync('/proc/' + pid + '/stat', 'utf8'));
}

function processEnvironmentSync(pid, startTicks, record) {
  const path = '/proc/' + pid;
  try {
    return readFileSync(path + '/environ', 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return;
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      try {
        const current = processIdentitySync(pid);
        if (current.startTicks !== startTicks || current.state === 'Z') return;
        // An unrelated process that predates the run cannot be its descendant.
        if (
          current.sessionId !== record.sessionId &&
          (BigInt(current.startTicks) < BigInt(record.startTicks) ||
            (typeof process.getuid === 'function' &&
              statSync(path).uid !== process.getuid()))
        )
          return;
      } catch (identityError) {
        if (identityError?.code === 'ENOENT' || identityError?.code === 'ESRCH')
          return;
        throw identityError;
      }
    }
    throw error;
  }
}

async function runProcessesRemain(record, runId, forced) {
  if (forced) {
    for (const process of liveProcessSnapshot(record)) {
      if (
        process.sessionId === record.sessionId ||
        hasRunMarker(process.environment, runId)
      )
        return true;
    }
    return false;
  }
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const identity = await processIdentity(pid).catch(() => undefined);
    if (!identity || identity.state === 'Z') continue;
    if (await markedProcess(pid, runId)) return true;
    if (record && identity.sessionId === record.sessionId) return true;
  }
  return false;
}

async function waitForRunProcessesExit(record, runId, graceMs, forced) {
  const deadline = Date.now() + graceMs;
  while (await runProcessesRemain(record, runId, forced)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(50, remaining));
  }
  return true;
}

async function verifyStoppedSessionState(job, result, workspace) {
  if (!job.session) return 'uncommitted';
  if (result?.type === 'completed') {
    try {
      await verifyCommittedSession(job, result, workspace);
      return 'committed';
    } catch {
      // A partial result cannot outrank the authenticated checkpoint.
    }
  }
  const rollback = await readRollbackCheckpoint(job);
  if (!rollback) {
    await verifyCurrentSession(job.session, workspace);
    await verifyAdapterEntry(job.session, workspace);
    return 'restored';
  }
  if (
    !(await currentSessionMatchesCheckpoint(job.session, rollback, workspace))
  )
    await restoreCheckpoint(job, rollback, workspace);
  if (
    !(await currentSessionMatchesCheckpoint(job.session, rollback, workspace))
  )
    throw new Error('Native rollback verification failed');
  await verifyAdapterEntry(job.session, workspace);
  return 'restored';
}

/** Returns this run's proven scratch directory, or undefined when absent. */
async function ownedScratch(job) {
  const scratch = join(
    '/tmp/hydra-worker-state',
    job.session?.seedRunId ?? job.runId,
  );
  const owner = await readRegularJson(join(scratch, 'rollback-owner.json'));
  if (owner) {
    validateRollbackOwner(owner, job);
    return scratch;
  }
  try {
    const directory = await open(
      scratch,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await directory.close();
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  throw new Error('Missing rollback ownership');
}

async function readRollbackCheckpoint(job) {
  const scratch = await ownedScratch(job);
  if (!scratch) return undefined;
  const checkpoint = await readRegularJson(join(scratch, 'rollback.json'));
  if (!checkpoint) return undefined;
  validateRollbackOwner(checkpoint, job);
  const session = job.session;
  if (
    checkpoint.nativeId !== session.nativeId ||
    checkpoint.adapterId !== session.adapterId ||
    checkpoint.revision !== session.revision ||
    typeof checkpoint.file !== 'string' ||
    !checkpoint.file ||
    isAbsolute(checkpoint.file) ||
    !Number.isSafeInteger(checkpoint.size) ||
    checkpoint.size < 1 ||
    !checksum.test(checkpoint.sha256 ?? '')
  )
    throw new Error('Invalid native rollback checkpoint');
  const source = await readCheckpoint(
    join(scratch, 'rollback.jsonl'),
    checkpoint.size,
  );
  if (createHash('sha256').update(source).digest('hex') !== checkpoint.sha256)
    throw new Error('Native rollback checkpoint changed');
  verifyCheckpointSource(source, checkpoint);
  return { checkpoint, source };
}

async function currentSessionMatchesCheckpoint(session, rollback, workspace) {
  try {
    const { file, source } = await verifyCurrentSession(session, workspace);
    return (
      file === rollback.checkpoint.file &&
      source.length === rollback.source.length &&
      createHash('sha256').update(source).digest('hex') ===
        rollback.checkpoint.sha256
    );
  } catch {
    return false;
  }
}

async function restoreCheckpoint(job, rollback, workspace) {
  const sessions = resolve(
    workspace,
    'runs',
    job.session.seedRunId,
    'pi-sessions',
  );
  const target = resolve(sessions, rollback.checkpoint.file);
  if (target === sessions || !target.startsWith(sessions + sep))
    throw new Error('Invalid native rollback path');
  const sessionsPath = await realpath(sessions);
  const parentPath = await realpath(dirname(target));
  if (sessionsPath !== sessions || parentPath !== dirname(target))
    throw new Error('Native rollback parent escaped');
  const current = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await current.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('Invalid native rollback target');
  } finally {
    await current.close();
  }
  await writeSyncedAtomic(target, rollback.source);
}

function validateRollbackOwner(value, job) {
  if (
    value?.version !== 1 ||
    value.runId !== job.runId ||
    value.generation !== job.generation ||
    value.seedRunId !== (job.session?.seedRunId ?? job.runId)
  )
    throw new Error('Invalid rollback ownership');
}

async function readCheckpoint(path, expectedSize) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize)
      throw new Error('Invalid native rollback data');
    const source = await file.readFile();
    if (source.length !== stat.size)
      throw new Error('Native rollback data changed while reading');
    return source;
  } finally {
    await file.close();
  }
}

function verifyCheckpointSource(source, checkpoint) {
  const text = source.toString('utf8');
  if (!Buffer.from(text).equals(source))
    throw new Error('Native rollback data is not exact UTF-8');
  const records = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (
    records[0]?.type !== 'session' ||
    records[0].id !== checkpoint.nativeId ||
    records.length !== checkpoint.revision
  )
    throw new Error('Native rollback contents changed');
}

async function verifyAdapterEntry(session, workspace) {
  const adapter = join(
    workspace,
    'runs',
    session.seedRunId,
    'pi-acp',
    'session-map.json',
  );
  const map = await readRegularJson(adapter);
  const entry = map?.sessions?.[session.adapterId];
  const { file } = await verifyCurrentSession(session, workspace);
  const expectedFile = join(
    '/tmp/hydra-worker-state',
    session.seedRunId,
    'agent',
    'sessions',
    file,
  );
  const expectedWork = join(workspace, 'runs', session.seedRunId, 'work');
  if (
    entry?.sessionId !== session.adapterId ||
    entry.cwd !== expectedWork ||
    entry.sessionFile !== expectedFile
  )
    throw new Error('Adapter session changed');
}

async function removeOwnedScratch(job) {
  const scratch = await ownedScratch(job);
  if (!scratch) return;
  if ((await realpath(scratch)) !== scratch)
    throw new Error('Rollback scratch identity changed');
  await rm(scratch, { recursive: true });
}

async function verifySessionState(job, result, workspace) {
  if (!job.session) return 'committed';
  if (job.memory === 'save') {
    await verifyAdapterEntry(job.session, workspace);
    return result?.type === 'completed' ? 'committed' : 'restored';
  }
  if (result?.type !== 'completed') {
    await verifyCurrentSession(job.session, workspace);
    return 'restored';
  }
  return 'committed';
}

async function verifyCommittedSession(job, result, workspace) {
  const session = result.session;
  if (
    session?.seedRunId !== job.session.seedRunId ||
    session.nativeId !== job.session.nativeId ||
    session.adapterId !== job.session.adapterId ||
    !Number.isSafeInteger(session.revision) ||
    session.revision <= job.session.revision ||
    (job.session.hasRetainedSources === true &&
      session.hasRetainedSources !== true) ||
    ((job.input.sources?.length ?? 0) > 0 &&
      session.hasRetainedSources !== true) ||
    (session.hasRetainedSources !== undefined &&
      session.hasRetainedSources !== true)
  )
    throw new Error('Completed session identity changed');
  await verifyAdapterEntry(session, workspace);
}

async function verifyCurrentSession(session, workspace) {
  const sessions = resolve(workspace, 'runs', session.seedRunId, 'pi-sessions');
  if ((await realpath(sessions)) !== sessions)
    throw new Error('Native session directory changed');
  const files = (await readdir(sessions, { recursive: true })).filter((file) =>
    file.endsWith('.jsonl'),
  );
  if (files.length !== 1) throw new Error('Missing exact native session');
  const file = files[0];
  const path = join(sessions, file);
  if ((await realpath(dirname(path))) !== dirname(path))
    throw new Error('Native session parent changed');
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let source;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1)
      throw new Error('Invalid native session file');
    source = await handle.readFile();
    if (source.length !== stat.size)
      throw new Error('Native session changed while reading');
  } finally {
    await handle.close();
  }
  const records = source
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (
    records[0]?.type !== 'session' ||
    records[0].id !== session.nativeId ||
    records.length !== session.revision
  )
    throw new Error('Native session was not restored');
  return { file, source };
}

async function readWorkerResult(path, runId, generation) {
  const result = await readRegularJson(path);
  if (!result) return undefined;
  if (
    result.runId !== runId ||
    result.generation !== generation ||
    !['completed', 'failed'].includes(result.type)
  )
    throw new Error('Invalid worker result');
  return result;
}

async function readMatchingJson(path, record) {
  const value = await readControlRecord(path);
  if (!value) return undefined;
  validateMatchingRecord(value, record);
  return value;
}

function validateMatchingRecord(value, record) {
  if (
    value.version !== 1 ||
    value.runId !== record.runId ||
    value.generation !== record.generation ||
    value.controlId !== record.controlId
  )
    throw new Error('Worker control identity changed');
}

async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await readRegularJson(path)) !== undefined) {
    const error = new Error('Worker record already exists');
    error.code = 'EEXIST';
    throw error;
  }
  await writeSyncedAtomic(path, JSON.stringify(value));
}
