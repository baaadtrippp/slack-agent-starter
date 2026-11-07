import { Sandbox } from '@vercel/sandbox';
import type { Session } from '@vercel/sandbox';
import { z } from 'zod';
import { workerResultSchema } from '../../../packages/contracts/src/index.js';
import type { WorkerInspection } from './gateway.js';
import type { RunRecord } from './store.js';

const proofSchema = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  generation: z.int().positive(),
  state: z.literal('exited'),
  processesExited: z.literal(true),
  stopRequested: z.boolean(),
  sessionSafe: z.enum(['committed', 'restored', 'uncommitted']),
  result: workerResultSchema.optional(),
});

/** Inspects or cancels one run in its recorded, still-running Sandbox session. */
export async function inspectSandboxRun(
  run: Pick<RunRecord, 'runId' | 'generation' | 'execution' | 'session'>,
  stop: boolean,
  recoverySession?: Session,
): Promise<WorkerInspection> {
  const target = run.execution;
  if (!target || (stop && recoverySession)) return { state: 'unknown' };
  const signal = AbortSignal.timeout(18_000);
  const session =
    recoverySession ??
    (
      await Sandbox.get({
        name: target.sandboxName,
        resume: false,
        signal,
      })
    ).currentSession();
  if (
    session.status !== 'running' ||
    (!recoverySession && session.sessionId !== target.sessionId)
  )
    return { state: 'unknown' };
  const command = await session.runCommand({
    cmd: 'node',
    args: ['/tmp/hydra-worker/control.mjs'],
    cwd: '/tmp/hydra-worker',
    env: {
      HYDRA_CONTROL: JSON.stringify({
        version: 1,
        runId: run.runId,
        generation: run.generation,
        action: stop ? 'cancel' : 'status',
        ...(recoverySession ? { environmentStopped: true } : {}),
      }),
    },
    timeoutMs: 15_000,
    signal,
  });
  if (command.exitCode !== 0) return { state: 'unknown' };
  const raw = await command.stdout({ signal });
  if (Buffer.byteLength(raw) > 32 * 1024) return { state: 'unknown' };
  const proof = proofSchema.safeParse(JSON.parse(raw));
  if (
    !proof.success ||
    proof.data.runId !== run.runId ||
    proof.data.generation !== run.generation
  )
    return { state: 'unknown' };
  const { stopRequested, sessionSafe, result } = proof.data;
  if (
    stop &&
    stopRequested &&
    sessionSafe === (run.session ? 'restored' : 'uncommitted')
  )
    return { state: 'stopped' };
  if (stop && sessionSafe === 'committed') {
    if (!run.session) return { state: 'stopped' };
    if (
      result?.type === 'completed' &&
      result.session &&
      result.runId === run.runId &&
      result.generation === run.generation
    )
      return { state: 'stopped', completed: result };
  }
  if (
    !stop &&
    !stopRequested &&
    (sessionSafe === 'committed' ||
      (sessionSafe === 'restored' && (!result || result.type === 'failed')))
  )
    return {
      state: 'exited',
      ...(result ? { result } : {}),
      ...(sessionSafe === 'restored' ? { sessionRestored: true } : {}),
      ...(recoverySession
        ? {
            artifactTarget: {
              sandboxName: target.sandboxName,
              sessionId: session.sessionId,
            },
          }
        : {}),
    };
  return { state: 'unknown' };
}
