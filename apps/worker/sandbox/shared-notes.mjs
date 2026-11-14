import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const header = '# Shared channel notes\n\n';
const maxNotes = 16;
const maxNoteBytes = 512;
const maxFileBytes = 20 * 1024;
const messageTs = /^\d{10}\.\d{6}$/;
const workspaceId = /^T[A-Z0-9]{1,31}$/;
const channelId = /^C[A-Z0-9]{1,31}$/;
const paths = {
  workspace: '/workspace',
  locks: '/tmp/hydra-shared-note-locks',
};

export const sharedNotesFull = new Error('Shared notes are full');
export const sharedNotesUnavailable = new Error('Shared notes unavailable');
export const sharedNoteSaved = 'Saved to this channel’s shared notes.';

export function isDriveFullError(error) {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if (current.code === 'ENOSPC' || current.code === 'EDQUOT') return true;
    current = current.cause;
  }
  return false;
}

function validNote(note) {
  return (
    typeof note === 'string' &&
    note.trim() === note &&
    note.length > 0 &&
    Buffer.byteLength(note) <= maxNoteBytes &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(note)
  );
}

/** Validates the gateway-selected operation before authenticating its scope. */
export function validSharedNoteJob(job) {
  if (job.memory === undefined) return true;
  const { input } = job;
  if (
    typeof input.workspaceId !== 'string' ||
    typeof input.channelId !== 'string' ||
    typeof input.messageTs !== 'string' ||
    !workspaceId.test(input.workspaceId) ||
    !channelId.test(input.channelId) ||
    !messageTs.test(input.messageTs)
  )
    return false;
  return (
    job.memory === 'read' ||
    (job.memory === 'save' &&
      validNote(input.text) &&
      !input.threadContext &&
      !input.attachments &&
      !input.sources &&
      !job.artifactOutput)
  );
}

function scope(input, workspace) {
  const key = createHash('sha256')
    .update(JSON.stringify([input.workspaceId, input.channelId]))
    .digest('hex');
  return { key, directory: join(workspace, 'shared-memory') };
}

async function readNotes(directory, key) {
  let file;
  try {
    if ((await realpath(directory)) !== directory) throw sharedNotesUnavailable;
    file = await open(
      join(directory, key + '.md'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  let text;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes)
      throw sharedNotesUnavailable;
    const stream = file.createReadStream({
      end: maxFileBytes,
      autoClose: false,
    });
    const bytes = Buffer.concat(await Array.fromAsync(stream));
    if (bytes.length !== stat.size) throw sharedNotesUnavailable;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
  if (!text.startsWith(header) || !text.endsWith('\n'))
    throw sharedNotesUnavailable;
  const notes = new Map();
  const rows = text.slice(header.length, -1).split('\n');
  if (rows.length > maxNotes) throw sharedNotesUnavailable;
  for (const row of rows) {
    const match = /^- (\d{10}\.\d{6}) (.+)$/.exec(row);
    if (!match || notes.has(match[1])) throw sharedNotesUnavailable;
    const note = JSON.parse(match[2]);
    if (!validNote(note)) throw sharedNotesUnavailable;
    notes.set(match[1], note);
  }
  return notes;
}

/** Opens only the Markdown file for this admitted workspace and channel. */
export async function readSharedNotes(input, { workspace } = paths) {
  const { key, directory } = scope(input, workspace);
  return [...(await readNotes(directory, key)).values()];
}

async function syncDirectory(path) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Serializes channel writes inside the one Sandbox holding the writable Drive. */
export async function saveSharedNote(
  input,
  signal,
  { workspace, locks } = paths,
) {
  const { key, directory } = scope(input, workspace);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = await open(
    join(locks, key),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // The child applies flock to the same open file description as lock.fd.
    // The worker retains it until close or process exit.
    const acquired = spawnSync('flock', ['-x', '-w', '4', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', lock.fd],
      timeout: 5_000,
    });
    if (acquired.status !== 0) throw sharedNotesUnavailable;
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const notes = await readNotes(directory, key);
    if (notes.has(input.messageTs)) {
      if (notes.get(input.messageTs) !== input.text)
        throw sharedNotesUnavailable;
    } else {
      if (notes.size >= maxNotes) throw sharedNotesFull;
      notes.set(input.messageTs, input.text);
      const contents =
        header +
        [...notes]
          .map(([id, note]) => '- ' + id + ' ' + JSON.stringify(note) + '\n')
          .join('');
      const temporary = join(directory, key + '.tmp');
      await rm(temporary, { force: true });
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(contents);
          await file.sync();
        } finally {
          await file.close();
        }
        signal.throwIfAborted();
        await rename(temporary, join(directory, key + '.md'));
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await syncDirectory(directory);
    await syncDirectory(workspace);
  } finally {
    await lock.close();
  }
}
