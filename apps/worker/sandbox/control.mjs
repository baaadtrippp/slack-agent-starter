import { randomUUID } from 'node:crypto';
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const request = JSON.parse(process.env.HYDRA_CONTROL ?? 'null');
    writeResponse(await controlRun(request));
  } catch {
    console.error('Sandbox worker control failed');
    process.exitCode = 1;
  }
}

export async function controlRun(
  request,
  { controls = '/tmp/hydra-worker-control', workspace = '/workspace' } = {},
) {
  if (
    request?.version !== 1 ||
    !uuid.test(request.runId) ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 1 ||
    !['cancel', 'status'].includes(request.action) ||
    (request.environmentStopped !== undefined &&
      (request.action !== 'status' || request.environmentStopped !== true))
  )
    throw new Error('Invalid worker control request');
  const paths = {
    control: join(controls, request.runId + '.json'),
    stop: join(controls, request.runId + '.stop.json'),
    exit: join(workspace, 'runs', request.runId, 'exit.json'),
    result: join(workspace, 'runs', request.runId, 'result.json'),
  };
  let status = await inspect(request, paths);
  if (request.action === 'status') return status;
  if (status.state === 'unknown') {
    status = await waitForRegistration(request, paths, 500);
    if (status.state === 'unknown') return status;
  }
  if (status.state === 'exited') {
    if (status.stopRequested) return status;
    const control = await readControlRecord(paths.control);
    if (!control) return status;
    validateControl(control, request);
    await writeStop(paths.stop, control);
    return inspect(request, paths);
  }
  const control = await readControlRecord(paths.control);
  validateControl(control, request);
  await writeStop(paths.stop, control);
  await signalExact(control, request.runId, 'SIGTERM');
  status = await waitForExit(request, paths, 10_000);
  return status;
}

async function inspect(request, paths) {
  const exit = await readRegularJson(paths.exit);
  if (exit) {
    validateExit(exit, request);
    let stopRequested = exit.stopRequested;
    if (!stopRequested) {
      const stop = await readControlRecord(paths.stop);
      if (stop) {
        const control = await readControlRecord(paths.control);
        validateControl(control, request);
        validateStop(stop, control);
        stopRequested = true;
      }
    }
    const response = {
      version: 1,
      runId: request.runId,
      generation: request.generation,
      state: 'exited',
      stopRequested,
      forced: exit.forced,
      ...(exit.forced ? { targetPgid: exit.targetPgid } : {}),
      sessionSafe: exit.sessionSafe,
      processesExited: true,
    };
    if (
      exit.sessionSafe === 'committed' ||
      (exit.sessionSafe === 'restored' && !stopRequested)
    ) {
      const result = await readRegularJson(paths.result);
      if (
        result &&
        (result.runId !== request.runId ||
          result.generation !== request.generation)
      )
        throw new Error('Invalid recovered worker result');
      if (exit.resultType && (!result || result.type !== exit.resultType))
        throw new Error('Worker result does not match exit proof');
      if (result) response.result = result;
    }
    return response;
  }
  if (request.environmentStopped) {
    const result = await readRegularJson(paths.result);
    if (
      result &&
      (result.runId !== request.runId ||
        result.generation !== request.generation)
    )
      throw new Error('Invalid recovered worker result');
    return {
      version: 1,
      runId: request.runId,
      generation: request.generation,
      state: 'exited',
      stopRequested: false,
      forced: false,
      sessionSafe: 'committed',
      processesExited: true,
      ...(result ? { result } : {}),
    };
  }
  const control = await readControlRecord(paths.control);
  if (!control) return baseStatus(request, 'unknown', false);
  validateControl(control, request);
  const stop = await readControlRecord(paths.stop);
  if (stop) validateStop(stop, control);
  const running =
    (await processStartTicks(control.pid).catch(() => undefined)) ===
    control.startTicks;
  return baseStatus(
    request,
    running && !stop ? 'running' : 'stopping',
    Boolean(stop),
  );
}

function baseStatus(request, state, stopRequested) {
  return {
    version: 1,
    runId: request.runId,
    generation: request.generation,
    state,
    stopRequested,
    forced: false,
  };
}

async function waitForExit(request, paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspect(request, paths);
    if (status.state === 'exited') return status;
    await delay(100);
  }
  return inspect(request, paths);
}

async function waitForRegistration(request, paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(25);
    const status = await inspect(request, paths);
    if (status.state !== 'unknown') return status;
  }
  return inspect(request, paths);
}

async function signalExact(control, runId, signal) {
  if (
    (await processStartTicks(control.pid).catch(() => undefined)) !==
      control.startTicks ||
    !(await markedProcess(control.pid, runId))
  )
    return;
  try {
    process.kill(control.pid, signal);
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
    environment
      ?.toString()
      .split('\0')
      .includes('HYDRA_RUN_ID=' + runId),
  );
}

async function writeStop(path, control) {
  const existing = await readControlRecord(path);
  if (existing) {
    validateStop(existing, control);
    return;
  }
  try {
    await createExclusiveJson(path, {
      version: 1,
      runId: control.runId,
      generation: control.generation,
      controlId: control.controlId,
      forced: false,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    validateStop(await readControlRecord(path), control);
  }
}

function validateControl(control, request) {
  if (
    control?.version !== 1 ||
    control.runId !== request.runId ||
    control.generation !== request.generation ||
    !uuid.test(control.controlId) ||
    !Number.isSafeInteger(control.pid) ||
    control.pid < 2 ||
    !/^\d+$/.test(control.startTicks) ||
    ((control.pgid !== undefined || control.sessionId !== undefined) &&
      (control.pgid !== control.pid || control.sessionId !== control.pid))
  )
    throw new Error('Invalid worker control record');
}

function validateStop(stop, control) {
  if (
    stop?.version !== 1 ||
    stop.runId !== control.runId ||
    stop.generation !== control.generation ||
    stop.controlId !== control.controlId ||
    stop.forced !== false
  )
    throw new Error('Invalid worker stop record');
}

function validateExit(exit, request) {
  if (
    exit.version !== 1 ||
    exit.runId !== request.runId ||
    exit.generation !== request.generation ||
    exit.state !== 'exited' ||
    exit.processesExited !== true ||
    !['committed', 'restored', 'uncommitted'].includes(exit.sessionSafe) ||
    typeof exit.stopRequested !== 'boolean' ||
    typeof exit.forced !== 'boolean' ||
    (exit.forced
      ? !exit.stopRequested ||
        !Number.isSafeInteger(exit.targetPgid) ||
        exit.targetPgid < 2
      : exit.targetPgid !== undefined) ||
    (exit.resultType !== undefined &&
      !['completed', 'failed'].includes(exit.resultType))
  )
    throw new Error('Invalid worker exit proof');
}

/** Reads an exact private control record while its synced temp link may remain. */
export function readControlRecord(path) {
  return readRegularJson(path, true);
}

async function readRegularJson(path, controlRecord = false) {
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
      stat.size < 1 ||
      stat.size > 32 * 1024 ||
      (stat.nlink !== 1 &&
        !(
          controlRecord &&
          stat.nlink === 2 &&
          (await hasPublishingLink(path, file, stat))
        ))
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

async function hasPublishingLink(path, file, stat) {
  // The final hard link already refers to a closed, synced inode. Only a
  // sibling temporary name from the exclusive publisher may explain link two.
  const directory = dirname(path);
  const prefix = basename(path) + '.';
  for (const name of await readdir(directory)) {
    if (
      !name.startsWith(prefix) ||
      !name.endsWith('.tmp') ||
      !uuid.test(name.slice(prefix.length, -4))
    )
      continue;
    const candidate = await lstat(join(directory, name)).catch(() => undefined);
    if (
      candidate?.isFile() &&
      candidate.dev === stat.dev &&
      candidate.ino === stat.ino
    )
      return true;
  }
  return (await file.stat()).nlink === 1;
}

async function createExclusiveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporary, path);
    await rm(temporary);
    await syncDirectory(dirname(path));
  } finally {
    await file?.close().catch(() => {});
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

function writeResponse(response) {
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) > 32 * 1024)
    throw new Error('Worker control response is too large');
  console.log(encoded);
}
