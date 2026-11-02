import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(
  join(tmpdir(), 'slack-agent-starter-gitleaks-'),
);
const corpus = join(temporaryRoot, 'corpus');
const emptyIgnoreDirectory = join(temporaryRoot, 'empty-ignore');

const runGitleaks = (mode, target) => {
  const result = spawnSync(
    'gitleaks',
    [
      mode,
      '--redact',
      '--no-banner',
      '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path',
      emptyIgnoreDirectory,
      target,
    ],
    { cwd: root, stdio: 'inherit' },
  );

  if (result.error) {
    throw result.error;
  }

  return result.status === 0;
};

let passed = true;

try {
  chmodSync(temporaryRoot, 0o700);
  mkdirSync(corpus, { mode: 0o700 });
  mkdirSync(emptyIgnoreDirectory, { mode: 0o700 });

  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const files = [...new Set(output.split('\0').filter(Boolean))];
  let copiedFiles = 0;

  for (const file of files) {
    const source = resolve(root, file);
    const sourceRelativePath = relative(root, source);

    if (
      sourceRelativePath.startsWith(`..${sep}`) ||
      sourceRelativePath === '..' ||
      isAbsolute(sourceRelativePath) ||
      !existsSync(source) ||
      !lstatSync(source).isFile()
    ) {
      continue;
    }

    const neutralFile =
      file === '.gitleaks.toml' || file === '.gitleaksignore'
        ? join('__gitleaks-control-files__', `${file}.content`)
        : file;
    const destination = resolve(corpus, neutralFile);
    const destinationRelativePath = relative(corpus, destination);

    if (
      destinationRelativePath.startsWith(`..${sep}`) ||
      destinationRelativePath === '..' ||
      isAbsolute(destinationRelativePath)
    ) {
      throw new Error(`Refusing unsafe Git path: ${file}`);
    }

    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    copiedFiles += 1;
  }

  console.log(`Scanning ${copiedFiles} Git-visible files.`);
  passed = runGitleaks('dir', corpus) && passed;

  const hasHistory =
    spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      stdio: 'ignore',
    }).status === 0;

  if (hasHistory) {
    console.log('Scanning Git history.');
    passed = runGitleaks('git', root) && passed;
  } else {
    console.log(
      'Git history scan skipped because the repository has no commits.',
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (!passed) {
  process.exitCode = 1;
}
