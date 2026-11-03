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
      result.text = await within(job.deadline - Date.now() - 9000, () =>
        prompt(job, model, key, root),
      );
      result.type = 'completed';
    } catch {
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
  } catch {
    console.error(
      JSON.stringify({ runId: job.runId, phase: 'drive_write_failed' }),
    );
    result.type = 'failed';
    result.text = failureText;
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

async function within(milliseconds, task) {
  if (milliseconds <= 0) throw new Error('Worker deadline expired');
  let timer;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Pi did not stop before the deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function prompt(job, model, key, root) {
  const scratch = join('/tmp/hydra-worker-state', job.runId);
  const agent = join(scratch, 'agent');
  const home = join(scratch, 'home');
  const work = join(root, 'work');
  const sessions = join(root, 'pi-sessions');
  const adapter = join(root, 'pi-acp');
  const launcher = join(scratch, 'launch-pi');
  try {
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
    try {
      const handle = await runtime.ensureSession({
        sessionKey: job.runId,
        agent: 'hydra',
        mode: 'persistent',
      });
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
      await runtime.shutdown();
    }

    const files = await Array.fromAsync(glob('**/*.jsonl', { cwd: sessions }));
    if (files.length !== 1) throw new Error('Missing exact native session');
    const records = (await readFile(join(sessions, files[0]), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const answer = records.findLast(
      (row) => row.type === 'message' && row.message.role === 'assistant',
    )?.message;
    const text = answer?.content
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
    if (answer?.stopReason !== 'stop' || !text)
      throw new Error('No successful Pi answer');
    return text.slice(0, 4000).toWellFormed();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
