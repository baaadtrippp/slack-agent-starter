import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const output = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
);

const files = output.split('\0').filter(Boolean);
const errors = [];

const requiredPaths = [
  '.github/workflows/quality.yml',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  'README.md',
  'apps/gateway/package.json',
  'apps/worker/package.json',
  'docs/spec',
  'packages/contracts/package.json',
  'pnpm-lock.yaml',
  'tests/fixtures',
];

const forbiddenSegments = new Set([
  '.claude',
  '.slack',
  '.vercel',
  'artifacts',
  'memory',
  'node_modules',
  'outputs',
  'sessions',
  'workspaces',
]);

const forbiddenNames = [
  /phase-0-handoff/i,
  /slack-agents-v1-spec\.html$/i,
  /course/i,
  /transcript/i,
];

const privatePathPatterns = [
  /[A-Za-z]:\\(?:Users|private-z)\\/i,
  /\/Users\/[^/]+\//,
  /\/(?:home|private-z)\/[^/]+\//,
];

for (const requiredPath of requiredPaths) {
  const prefix = `${requiredPath}/`;
  if (
    !files.includes(requiredPath) &&
    !files.some((file) => file.startsWith(prefix))
  ) {
    errors.push(`missing required repository path: ${requiredPath}`);
  }
}

for (const file of files) {
  const normalized = file.replaceAll('\\', '/');
  const segments = normalized.split('/');

  const hasCredentialEnvironmentFile = segments.some(
    (segment) =>
      segment === '.env' ||
      (segment.startsWith('.env.') && segment !== '.env.example'),
  );

  if (
    hasCredentialEnvironmentFile ||
    segments.some((segment) => forbiddenSegments.has(segment))
  ) {
    errors.push(`runtime or credential path is visible to Git: ${normalized}`);
  }

  if (forbiddenNames.some((pattern) => pattern.test(normalized))) {
    errors.push(`private reference material is visible to Git: ${normalized}`);
  }

  const absolutePath = resolve(root, file);
  if (
    !statSync(absolutePath).isFile() ||
    statSync(absolutePath).size > 1_000_000
  ) {
    continue;
  }

  let content;
  try {
    content = readFileSync(absolutePath, 'utf8');
  } catch {
    continue;
  }

  if (content.includes('\0')) {
    continue;
  }

  if (privatePathPatterns.some((pattern) => pattern.test(content))) {
    errors.push(`local absolute path found in ${normalized}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository boundary check passed for ${files.length} files.`);
}
