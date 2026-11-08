import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
// @ts-expect-error No declaration file is shipped for the Sandbox module.
import * as sharedNotes from '../apps/worker/sandbox/shared-notes.mjs';

const { isDriveFullError, readSharedNotes, saveSharedNote, sharedNotesFull } =
  sharedNotes;

const exec = promisify(execFile);
const moduleUrl = new URL(
  '../apps/worker/sandbox/shared-notes.mjs',
  import.meta.url,
);
const signal = new AbortController().signal;
let root: string;
let paths: { workspace: string; locks: string };

function note(number: number, text: string) {
  return {
    workspaceId: 'TTEST1',
    channelId: 'CTEST1',
    messageTs: '1800000000.' + String(number).padStart(6, '0'),
    text,
  };
}

function writeInNewWorker(input: ReturnType<typeof note>) {
  return exec(process.execPath, [
    '--input-type=module',
    '--eval',
    'const {saveSharedNote} = await import(process.argv[1]);' +
      'await saveSharedNote(JSON.parse(process.argv[2]), new AbortController().signal, JSON.parse(process.argv[3]));',
    moduleUrl.href,
    JSON.stringify(input),
    JSON.stringify(paths),
  ]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shared-notes-test-'));
  paths = { workspace: join(root, 'workspace'), locks: join(root, 'locks') };
  await mkdir(paths.workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('retains both concurrent writes and deduplicates across worker replacement', async () => {
  const first = note(1, 'Synthetic badge is purple.');
  const second = note(2, 'Synthetic badge is made of paper.');
  const transcript = join(paths.workspace, 'runs', 'synthetic-writer');
  await mkdir(transcript, { recursive: true });
  await writeFile(
    join(transcript, 'transcript.jsonl'),
    'PRIVATE_THREAD_SENTINEL',
  );

  await Promise.all([writeInNewWorker(first), writeInNewWorker(second)]);
  await rm(transcript, { recursive: true });
  await rm(paths.locks, { recursive: true });
  await writeInNewWorker(first);

  const thirdThread = note(3, 'What do we know about the badge?');
  expect((await readSharedNotes(thirdThread, paths)).sort()).toEqual(
    [first.text, second.text].sort(),
  );
  expect(
    await readSharedNotes({ ...thirdThread, channelId: 'CTEST2' }, paths),
  ).toEqual([]);
  expect(
    await readSharedNotes({ ...thirdThread, workspaceId: 'TTEST2' }, paths),
  ).toEqual([]);
  const memory = join(paths.workspace, 'shared-memory');
  const [file] = await readdir(memory);
  const stored = await readFile(join(memory, file!), 'utf8');
  expect(stored).not.toContain('PRIVATE_THREAD_SENTINEL');
  expect(stored.match(/1800000000\.000001/g)).toHaveLength(1);
});

it('preserves the prior snapshot if a write is interrupted before rename', async () => {
  const first = note(1, 'Initial note');
  await saveSharedNote(first, signal, paths);
  const interrupted = new Error('Synthetic interruption');
  let checks = 0;
  await expect(
    saveSharedNote(
      note(2, 'Uncommitted note'),
      {
        throwIfAborted() {
          if (++checks === 2) throw interrupted;
        },
      },
      paths,
    ),
  ).rejects.toBe(interrupted);
  expect(await readSharedNotes(first, paths)).toEqual([first.text]);
  await writeInNewWorker(note(3, 'Next note'));
  expect(await readSharedNotes(first, paths)).toEqual([
    first.text,
    'Next note',
  ]);
});

it('preserves the prior snapshot if the Drive fills before rename', async () => {
  const first = note(1, 'Initial note');
  await saveSharedNote(first, signal, paths);
  const driveFull = Object.assign(new Error('Synthetic full Drive'), {
    code: 'ENOSPC',
  });
  let checks = 0;
  await expect(
    saveSharedNote(
      note(2, 'Uncommitted note'),
      {
        throwIfAborted() {
          if (++checks === 2) throw driveFull;
        },
      },
      paths,
    ),
  ).rejects.toBe(driveFull);
  expect(isDriveFullError(driveFull)).toBe(true);
  expect(await readSharedNotes(first, paths)).toEqual([first.text]);
});

it('refuses excess notes and preserves all previously saved entries', async () => {
  for (let number = 1; number <= 16; number++)
    await saveSharedNote(
      note(number, 'Synthetic note ' + number),
      signal,
      paths,
    );
  await expect(
    saveSharedNote(note(17, 'Extra note'), signal, paths),
  ).rejects.toBe(sharedNotesFull);
  expect(await readSharedNotes(note(18, 'Query'), paths)).toHaveLength(16);
});
