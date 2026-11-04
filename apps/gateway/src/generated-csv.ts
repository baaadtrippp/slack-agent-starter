import { Sandbox } from '@vercel/sandbox';
import { isUtf8 } from 'node:buffer';
import type { SandboxTarget } from './store.js';

const maxBytes = 16 * 1024;

// Run in the reserved Linux Sandbox. Open each component relative to an
// already-open directory so replacing a path cannot redirect the next open.
export const readRunCsv = `
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

try {
  const [workspace, runId] = process.argv.slice(1);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId))
    throw new Error();
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
  const dirFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
  let dir = openSync(workspace, dirFlags);
  for (const name of ['runs', runId, 'results']) {
    const next = openSync('/proc/self/fd/' + dir + '/' + name, dirFlags);
    closeSync(dir);
    dir = next;
  }
  const file = openSync('/proc/self/fd/' + dir + '/result.csv',
    O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  closeSync(dir);
  const limit = ${maxBytes};
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

export async function collectRunCsv(runId: string, target: SandboxTarget) {
  const signal = AbortSignal.timeout(5_000);
  const sandbox = await Sandbox.get({
    name: target.sandboxName,
    resume: false,
    signal,
  });
  const session = sandbox.currentSession();
  if (session.status !== 'running' || session.sessionId !== target.sessionId)
    throw new Error('Artifact Sandbox session is unavailable');

  const command = await session.runCommand({
    cmd: 'node',
    args: ['--input-type=module', '-e', readRunCsv, '--', '/workspace', runId],
    timeoutMs: 3_000,
    signal,
  });
  if (command.exitCode !== 0) throw new Error('Artifact is unavailable');
  const encoded = await command.stdout({ signal });
  if (encoded.length > Math.ceil(maxBytes / 3) * 4)
    throw new Error('Artifact transfer exceeded its limit');
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString('base64') !== encoded ||
    !isUtf8(bytes)
  )
    throw new Error('Artifact is not bounded UTF-8 text');
  return bytes;
}
