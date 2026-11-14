import { isUtf8 } from 'node:buffer';
import {
  artifactFormats,
  INPUT_BYTE_LIMIT,
} from '../../../packages/contracts/src/index.js';
import type { ArtifactFormat } from '../../../packages/contracts/src/index.js';
import type { SandboxTarget } from './store.js';
import { getRunningSession } from './worker-control.js';

// Run in the reserved Linux Sandbox. Open each component relative to an
// already-open directory so replacing a path cannot redirect the next open.
export const readRunArtifact = `
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

try {
  const [workspace, runId, format = 'csv'] = process.argv.slice(1);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId))
    throw new Error();
  if (!${JSON.stringify(artifactFormats)}.includes(format))
    throw new Error();
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
  const dirFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
  let dir = openSync(workspace, dirFlags);
  for (const name of ['runs', runId, 'results']) {
    const next = openSync('/proc/self/fd/' + dir + '/' + name, dirFlags);
    closeSync(dir);
    dir = next;
  }
  const file = openSync('/proc/self/fd/' + dir + '/result.' + format,
    O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  closeSync(dir);
  const limit = ${INPUT_BYTE_LIMIT};
  const stat = fstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit)
    throw new Error();
  const bytes = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < bytes.length) {
    const read = readSync(file, bytes, length, bytes.length - length, null);
    if (read === 0) break;
    length += read;
  }
  closeSync(file);
  if (length !== stat.size) throw new Error();
  process.stdout.write(bytes.subarray(0, length).toString('base64'));
} catch {
  process.exitCode = 1;
}
`;

/**
 * Collects a bounded UTF-8 result file from the run's reserved Sandbox session.
 * Rejects stale sessions and invalid transfers before returning bytes.
 */
export async function collectRunArtifact(
  runId: string,
  target: SandboxTarget,
  format: ArtifactFormat = 'csv',
) {
  const signal = AbortSignal.timeout(5_000);
  const session = await getRunningSession(target, signal);
  if (!session) throw new Error('Artifact Sandbox session is unavailable');

  const command = await session.runCommand({
    cmd: 'node',
    args: [
      '--input-type=module',
      '-e',
      readRunArtifact,
      '--',
      '/workspace',
      runId,
      format,
    ],
    timeoutMs: 3_000,
    signal,
  });
  if (command.exitCode !== 0) throw new Error('Artifact is unavailable');
  const encoded = await command.stdout({ signal });
  if (encoded.length > Math.ceil(INPUT_BYTE_LIMIT / 3) * 4)
    throw new Error('Artifact transfer exceeded its limit');
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > INPUT_BYTE_LIMIT ||
    bytes.toString('base64') !== encoded ||
    !isUtf8(bytes)
  )
    throw new Error('Artifact is not bounded UTF-8 text');
  return bytes;
}
