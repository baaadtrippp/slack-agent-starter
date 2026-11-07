import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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
  } = {},
) {
  if (
    job?.version !== 1 ||
    !uuid.test(job.runId) ||
    !Number.isSafeInteger(job.generation) ||
    job.generation < 1
  )
    throw new Error('Invalid supervised worker job');

  const child = spawn(process.execPath, [worker], {
    detached: true,
    env: { ...process.env, HYDRA_RUN_ID: job.runId },
    stdio: 'inherit',
  });
  if (!child.pid) throw new Error('Worker process did not start');
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const record = {
    version: 1,
    runId: job.runId,
    generation: job.generation,
    controlId: randomUUID(),
    pid: child.pid,
    startTicks: await processStartTicks(child.pid),
  };
  try {
    await createExclusiveJson(join(controls, job.runId + '.json'), record);
  } catch (error) {
    await signalExact(record, job.runId, 'SIGTERM');
    await closed;
    throw error;
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

  if (await markedProcessesRemain(job.runId))
    throw new Error('Worker descendants remain active');
  const stop = await readMatchingJson(
    join(controls, job.runId + '.stop.json'),
    record,
  );
  const runRoot = join(workspace, 'runs', job.runId);
  const result = await readWorkerResult(
    join(runRoot, 'result.json'),
    job.runId,
    job.generation,
  );
  const sessionSafe = stop
    ? job.session
      ? await verifyStoppedSession(job, result, workspace)
      : 'uncommitted'
    : 'committed';
  const exit = {
    version: 1,
    runId: job.runId,
    generation: job.generation,
    state: 'exited',
    stopRequested: Boolean(stop),
    forced: false,
    processesExited: true,
    sessionSafe,
    ...(result ? { resultType: result.type } : {}),
    exitCode: outcome.code,
    signal: outcome.signal,
  };
  await createExclusiveJson(join(runRoot, 'exit.json'), exit);
  return exit;
}

async function signalExact(record, runId, signal) {
  if (
    (await processStartTicks(record.pid).catch(() => undefined)) !==
      record.startTicks ||
    !(await markedProcess(record.pid, runId))
  )
    return;
  try {
    process.kill(record.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function processStartTicks(pid) {
  const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  const ticks = fields[19];
  if (!/^\d+$/.test(ticks)) throw new Error('Invalid worker process identity');
  return ticks;
}

async function markedProcess(pid, runId) {
  const environment = await readFile('/proc/' + pid + '/environ').catch(
    () => undefined,
  );
  return Boolean(
    environment?.includes(Buffer.from('HYDRA_RUN_ID=' + runId + '\0')),
  );
}

async function markedProcessesRemain(runId) {
  for (const entry of await readdir('/proc')) {
    if (/^\d+$/.test(entry) && (await markedProcess(Number(entry), runId)))
      return true;
  }
  return false;
}

async function verifyStoppedSession(job, result, workspace) {
  try {
    await verifyCurrentSession(job.session, workspace);
    return 'restored';
  } catch (error) {
    if (result?.type !== 'completed') throw error;
    await verifyCommittedSession(job, result, workspace);
    return 'committed';
  }
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
  const file = await verifyCurrentSession(session, workspace);
  const adapter = join(
    workspace,
    'runs',
    session.seedRunId,
    'pi-acp',
    'session-map.json',
  );
  const map = await readRegularJson(adapter);
  const entry = map?.sessions?.[session.adapterId];
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
    throw new Error('Completed adapter session changed');
}

async function verifyCurrentSession(session, workspace) {
  const sessions = join(workspace, 'runs', session.seedRunId, 'pi-sessions');
  const files = (await readdir(sessions, { recursive: true })).filter((file) =>
    file.endsWith('.jsonl'),
  );
  if (files.length !== 1) throw new Error('Missing exact native session');
  const source = await readFile(join(sessions, files[0]), 'utf8');
  const records = source
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (
    records[0]?.type !== 'session' ||
    records[0].id !== session.nativeId ||
    records.length !== session.revision
  )
    throw new Error('Native session was not restored');
  return files[0];
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
  const value = await readRegularJson(path);
  if (!value) return undefined;
  if (
    value.version !== 1 ||
    value.runId !== record.runId ||
    value.generation !== record.generation ||
    value.controlId !== record.controlId
  )
    throw new Error('Worker control identity changed');
  return value;
}

async function readRegularJson(path) {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 16 * 1024
    )
      throw new Error('Invalid worker record');
    const source = await file.readFile('utf8');
    if (Buffer.byteLength(source) !== stat.size)
      throw new Error('Worker record changed while reading');
    return JSON.parse(source);
  } finally {
    await file.close();
  }
}

async function createExclusiveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await copyFile(temporary, path, constants.COPYFILE_EXCL);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
