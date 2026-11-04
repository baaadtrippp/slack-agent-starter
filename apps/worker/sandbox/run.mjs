import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  glob,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
} from 'acpx/runtime';

const failureText =
  'The agent could not finish this run. You can retry by mentioning it again.';
const callbackReserve = 12_000;
const unconfirmedExit = new Error('Pi shutdown could not be verified');
const bin = join(import.meta.dirname, 'node_modules', '.bin');

try {
  const { HYDRA_JOB, HYDRA_MODEL, OPENROUTER_API_KEY } = process.env;
  delete process.env.HYDRA_JOB;
  delete process.env.HYDRA_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  await run(JSON.parse(HYDRA_JOB ?? 'null'), HYDRA_MODEL, OPENROUTER_API_KEY);
} catch {
  console.error('Sandbox worker could not complete its callback');
  process.exitCode = 1;
}

async function run(job, model, key) {
  if (
    job?.version !== 1 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(job.runId) ||
    !Number.isSafeInteger(job.generation) ||
    job.generation < 1 ||
    !Number.isSafeInteger(job.deadline) ||
    job.deadline <= Date.now() ||
    typeof job.input?.text !== 'string' ||
    !job.input.text.trim() ||
    job.input.text.length > 12_000 ||
    !/^[0-9a-f]{64}$/.test(job.callbackToken) ||
    (job.session !== undefined &&
      (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
        job.session?.seedRunId ?? '',
      ) ||
        job.session.seedRunId === job.runId ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
          job.session?.nativeId ?? '',
        ) ||
        typeof job.session?.adapterId !== 'string' ||
        !job.session.adapterId ||
        job.session.adapterId.length > 128 ||
        !Number.isSafeInteger(job.session?.revision) ||
        job.session.revision < 1)) ||
    typeof model !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]{1,127}$/i.test(model) ||
    !key
  )
    throw new Error('Invalid worker configuration');

  const callback = new URL(job.callbackUrl);
  if (
    callback.protocol !== 'https:' ||
    callback.pathname !== '/api/worker/callback' ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    throw new Error('Invalid callback destination');
  const headers = { authorization: `Bearer ${job.callbackToken}` };
  const admission = new URL(callback);
  admission.searchParams.set('runId', job.runId);
  admission.searchParams.set('generation', String(job.generation));
  const authorized = await fetch(admission, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (authorized.status !== 204) throw new Error('Run admission denied');

  const root = join('/workspace/runs', job.runId);
  const manifest = join(root, 'result.json');
  const result = {
    version: 1,
    runId: job.runId,
    generation: job.generation,
    eventId: randomUUID(),
    sequence: 1,
    type: 'failed',
    text: failureText,
  };
  try {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An active or interrupted run owns this directory. Never replay a prompt.
      const saved = await readFile(manifest, 'utf8').catch(() => undefined);
      if (!saved) return;
      const prior = JSON.parse(saved);
      if (prior.runId !== job.runId || prior.generation !== job.generation)
        return;
      execFileSync('sync', ['-f', root], { stdio: 'ignore', timeout: 3000 });
      return deliver(callback, headers, prior, job.deadline);
    }
    try {
      const completed = await prompt(job, model, key, root);
      result.text = completed.text;
      result.session = completed.session;
      result.type = 'completed';
    } catch (error) {
      if (error === unconfirmedExit) throw error;
      console.error(
        JSON.stringify({ runId: job.runId, phase: 'pi_turn_failed' }),
      );
    }
    await writeFile(manifest + '.tmp', JSON.stringify(result), {
      mode: 0o600,
      flag: 'wx',
    });
    try {
      execFileSync('sync', ['-f', root], { stdio: 'ignore', timeout: 1500 });
      await rename(manifest + '.tmp', manifest);
      execFileSync('sync', ['-f', root], { stdio: 'ignore', timeout: 1500 });
    } catch (error) {
      await rm(manifest, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error === unconfirmedExit) throw error;
    console.error(
      JSON.stringify({ runId: job.runId, phase: 'drive_write_failed' }),
    );
    result.type = 'failed';
    result.text = failureText;
    delete result.session;
  }

  await deliver(callback, headers, result, job.deadline);
}

async function deliver(callback, headers, result, deadline) {
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
    if (attempt > 0) {
      await delay(
        Math.min(250 * 2 ** (attempt - 1), Math.max(0, deadline - Date.now())),
      );
      if (Date.now() >= deadline) break;
    }
    try {
      const response = await fetch(callback, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(result),
        redirect: 'error',
        signal: AbortSignal.timeout(
          Math.min(3000, Math.max(1, deadline - Date.now())),
        ),
      });
      if (response.ok) return;
      if (
        response.status !== 408 &&
        response.status !== 429 &&
        response.status < 500
      )
        break;
    } catch {
      // Retry transport errors with the same result ID.
    }
  }
  throw new Error('Callback was not accepted');
}

async function prompt(job, model, key, root) {
  const seedRunId = job.session?.seedRunId ?? job.runId;
  const sessionRoot = job.session ? join('/workspace/runs', seedRunId) : root;
  const scratch = join('/tmp/hydra-worker-state', seedRunId);
  const agent = join(scratch, 'agent');
  const home = join(scratch, 'home');
  const work = join(sessionRoot, 'work');
  const sessions = join(sessionRoot, 'pi-sessions');
  const adapter = join(sessionRoot, 'pi-acp');
  const launcher = join(scratch, 'launch-pi');
  let before;
  let adapterId;
  let started = false;
  let stopped = true;
  await mkdir(dirname(scratch), { recursive: true, mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  try {
    if (job.session)
      before = await verifySavedSession(
        job.session,
        sessions,
        adapter,
        scratch,
        work,
      );
    await Promise.all(
      [agent, join(home, '.pi'), work, sessions, adapter].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    await symlink(sessions, join(agent, 'sessions'));
    await symlink(adapter, join(home, '.pi', 'pi-acp'));
    await writeFile(
      launcher,
      '#!/bin/bash\nexec pi --provider openrouter --model "$HYDRA_MODEL" --thinking off --tools "" --no-extensions --no-mcp --no-skills --no-context-files "$@"\n',
      { mode: 0o700 },
    );

    const timeoutMs = job.deadline - Date.now() - callbackReserve;
    if (timeoutMs <= 0) throw new Error('Worker deadline expired');
    const signal = AbortSignal.timeout(timeoutMs);
    const runtime = createAcpRuntime({
      cwd: work,
      sessionStore: createRuntimeStore({ stateDir: join(scratch, 'acpx') }),
      agentRegistry: createAgentRegistry({
        overrides: { hydra: [join(bin, 'pi-acp')] },
      }),
      agentProcessEnvAllow: ['NODE_EXTRA_CA_CERTS'],
      agentProcessEnv: {
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: agent,
        PI_ACP_PI_COMMAND: launcher,
        HYDRA_MODEL: model,
        OPENROUTER_API_KEY: key,
      },
      permissionMode: 'deny-all',
      fs: false,
      terminal: false,
      timeoutMs,
    });
    stopped = false;
    try {
      const handle = await runtime.ensureSession({
        sessionKey: job.runId,
        agent: 'hydra',
        mode: 'persistent',
        resumeSessionId: job.session?.adapterId,
      });
      if (job.session && handle.backendSessionId !== job.session.adapterId)
        throw new Error('Adapter resumed a different session');
      adapterId = handle.backendSessionId;
      if (typeof adapterId !== 'string' || !adapterId)
        throw new Error('Adapter returned no session ID');
      started = true;
      const turn = runtime.startTurn({
        handle,
        mode: 'prompt',
        requestId: job.runId,
        text: job.input.text,
        signal,
        timeoutMs,
      });
      for await (const event of turn.events) {
        if (event.type === 'error') break;
      }
      if ((await turn.result).status !== 'completed')
        throw new Error('Pi turn failed');
    } finally {
      try {
        await runtime.shutdown();
        stopped = true;
      } catch {
        throw unconfirmedExit;
      }
    }

    const saved = job.session
      ? await verifySavedSession(
          job.session,
          sessions,
          adapter,
          scratch,
          work,
          false,
        )
      : await readNativeSession(sessions);
    if (
      before &&
      (saved.file !== before.file || saved.nativeId !== before.nativeId)
    )
      throw new Error('Native session identity changed');
    const newRecords = saved.records.slice(before?.records.length ?? 0);
    const users = newRecords.filter(
      (row) => row.type === 'message' && row.message.role === 'user',
    );
    const answer = newRecords.findLast(
      (row) => row.type === 'message' && row.message.role === 'assistant',
    )?.message;
    if (
      users.length !== 1 ||
      messageText(users[0].message) !== job.input.text ||
      !answer
    )
      throw new Error('Expected one new Pi turn');
    const text = answer?.content
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
    if (answer?.stopReason !== 'stop' || !text)
      throw new Error('No successful Pi answer');
    return {
      text: text.slice(0, 4000).toWellFormed(),
      session: {
        seedRunId,
        nativeId: saved.nativeId,
        adapterId,
        revision: saved.records.length,
      },
    };
  } catch (error) {
    if (before && started && stopped) {
      // The committed transcript is safe to restore only after Pi has exited.
      const path = join(sessions, before.file);
      const temporary = `${path}.${job.runId}.tmp`;
      await writeFile(temporary, before.source, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    }
    throw error;
  } finally {
    if (stopped) await rm(scratch, { recursive: true, force: true });
  }
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

async function verifySavedSession(
  reference,
  sessions,
  adapter,
  scratch,
  work,
  requireRevision = true,
) {
  const saved = await readNativeSession(sessions);
  if (
    saved.nativeId !== reference.nativeId ||
    (requireRevision && saved.records.length !== reference.revision)
  )
    throw new Error('Native session ID does not match');
  const seed = JSON.parse(
    await readFile(join(dirname(sessions), 'result.json'), 'utf8'),
  );
  if (
    seed.runId !== reference.seedRunId ||
    seed.type !== 'completed' ||
    seed.session?.seedRunId !== reference.seedRunId ||
    seed.session?.nativeId !== reference.nativeId ||
    seed.session?.adapterId !== reference.adapterId
  )
    throw new Error('Seed result identity does not match');
  const map = JSON.parse(
    await readFile(join(adapter, 'session-map.json'), 'utf8'),
  );
  if (!map?.sessions || !Object.hasOwn(map.sessions, reference.adapterId))
    throw new Error('Adapter session is missing');
  const entry = map.sessions[reference.adapterId];
  const expectedPath = join(scratch, 'agent', 'sessions', saved.file);
  if (
    entry?.sessionId !== reference.adapterId ||
    entry.cwd !== work ||
    entry.sessionFile !== expectedPath
  )
    throw new Error('Adapter session identity does not match');
  return { ...saved, adapterId: reference.adapterId };
}

async function readNativeSession(sessions) {
  const files = await Array.fromAsync(glob('**/*.jsonl', { cwd: sessions }));
  if (files.length !== 1) throw new Error('Missing exact native session');
  const source = await readFile(join(sessions, files[0]), 'utf8');
  const records = source
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const nativeId = records[0]?.type === 'session' ? records[0].id : undefined;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(nativeId ?? ''))
    throw new Error('Invalid native session ID');
  return { file: files[0], nativeId, records, source };
}
