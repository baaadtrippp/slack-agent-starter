import { isUtf8 } from 'node:buffer';
import { z } from 'zod';

import { INPUT_BYTE_LIMIT } from '../../../packages/contracts/src/index.js';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
const maxImageEdge = 1_024;
const csvMimetypes = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
];
const textExtensions = new Set([
  'bash',
  'c',
  'cc',
  'cfg',
  'conf',
  'cpp',
  'cs',
  'css',
  'cxx',
  'diff',
  'fish',
  'go',
  'h',
  'hh',
  'hpp',
  'htm',
  'html',
  'hxx',
  'ini',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'kt',
  'kts',
  'less',
  'markdown',
  'md',
  'mjs',
  'ndjson',
  'patch',
  'php',
  'ps1',
  'py',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);
const sourceNames = new Set([
  'CMakeLists.txt',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'README',
]);
const jsonMimetypes = new Set(['application/json', 'text/json']);
const sourceApplicationMimetypes = new Map([
  ['diff', new Set(['application/octet-stream', 'application/x-patch'])],
  ['patch', new Set(['application/octet-stream', 'application/x-patch'])],
  ['js', new Set(['application/javascript'])],
  ['json', jsonMimetypes],
  ['ts', new Set(['application/typescript', 'video/mp2t'])],
  ['xml', new Set(['application/xml'])],
]);
const metadata = z.looseObject({
  mode: z.enum(['hosted', 'snippet']),
  is_external: z.literal(false).optional(),
  name: z.string(),
  mimetype: z.string(),
  size: z.number().int().positive(),
  url_private: z.url(),
});

export type SlackFileKind = 'csv' | 'pdf' | 'png' | 'jpeg' | 'text';

export function isSafeSlackFilename(name: string) {
  return (
    name.length > 0 &&
    name.length <= 120 &&
    name !== '.' &&
    name !== '..' &&
    !/[\p{Cc}/\\]/u.test(name)
  );
}

export function selectSlackFileKind(raw: unknown): SlackFileKind | undefined {
  const parsed = metadata.safeParse(raw);
  if (!parsed.success) return;
  const file = parsed.data;
  if (!isSafeSlackFilename(file.name)) return;

  if (/\.csv$/i.test(file.name) && csvMimetypes.includes(file.mimetype))
    return 'csv';
  if (
    file.mode === 'hosted' &&
    /\.pdf$/i.test(file.name) &&
    file.mimetype === 'application/pdf'
  )
    return 'pdf';
  if (
    file.mode === 'hosted' &&
    /\.png$/i.test(file.name) &&
    file.mimetype === 'image/png'
  )
    return 'png';
  if (
    file.mode === 'hosted' &&
    /\.jpe?g$/i.test(file.name) &&
    file.mimetype === 'image/jpeg'
  )
    return 'jpeg';

  const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  const textName =
    sourceNames.has(file.name) || textExtensions.has(extension ?? '');
  const textMime =
    file.mimetype.startsWith('text/') ||
    sourceApplicationMimetypes.get(extension ?? '')?.has(file.mimetype);
  return textName && textMime ? 'text' : undefined;
}

export async function downloadSlackFile(
  files: unknown,
  token: string,
  kind: SlackFileKind,
) {
  const label = kind === 'text' ? 'text file' : kind.toUpperCase();
  const inaccessible = `I could not read the Slack file. Check that it is shared here and mention me again with the ${label}.`;
  const unsupported =
    kind === 'pdf'
      ? 'Attach one Slack-hosted text-based PDF file.'
      : kind === 'png'
        ? 'Attach one Slack-hosted PNG file up to 1,024 pixels on either edge.'
        : kind === 'jpeg'
          ? 'Attach one Slack-hosted JPEG file up to 1,024 pixels on either edge.'
          : kind === 'text'
            ? 'Attach one supported Slack-hosted UTF-8 text, Markdown, source, diff, or JSON file.'
            : 'Attach one Slack-hosted CSV file encoded as UTF-8.';
  const oversized = `The ${label} exceeds the 16 KiB limit for this test. Attach a smaller file.`;

  if (!Array.isArray(files) || files.length !== 1) return unsupported;
  const parsed = metadata.safeParse(files[0]);
  if (!parsed.success) return unsupported;
  const file = parsed.data;
  if (selectSlackFileKind(file) !== kind) return unsupported;
  if (file.size > INPUT_BYTE_LIMIT) return oversized;
  const url = new URL(file.url_private);
  if (
    url.origin !== 'https://files.slack.com' ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/files-pri/')
  )
    return unsupported;

  try {
    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const reader = response.body?.getReader();
    if (!reader) return inaccessible;
    try {
      if (
        !response.ok ||
        (response.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('text/html') &&
          !(kind === 'text' && /\.html?$/i.test(file.name)))
      )
        return inaccessible;
      const bytes = Buffer.alloc(file.size);
      let offset = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > INPUT_BYTE_LIMIT - offset) return oversized;
        if (value.length > bytes.length - offset) return inaccessible;
        bytes.set(value, offset);
        offset += value.length;
      }
      if (offset !== bytes.length) return inaccessible;
      const valid =
        kind === 'pdf'
          ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
          : kind === 'png'
            ? isSmallPng(bytes)
            : kind === 'jpeg'
              ? isSmallJpeg(bytes)
              : !bytes.includes(0) && isUtf8(bytes);
      return valid ? bytes : unsupported;
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return inaccessible;
  }
}

function isSmallPng(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('latin1', 12, 16) !== 'IHDR' ||
    !bytes.subarray(-12).equals(pngEnd)
  )
    return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return (
    width > 0 && width <= maxImageEdge && height > 0 && height <= maxImageEdge
  );
}

function isSmallJpeg(bytes: Buffer) {
  if (
    bytes.length < 14 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  )
    return false;

  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8)
      return false;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length - 2) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return false;

    const startOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (startOfFrame) {
      if (length < 8) return false;
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
    }
    if (marker === 0xda)
      return (
        width > 0 &&
        width <= maxImageEdge &&
        height > 0 &&
        height <= maxImageEdge
      );
    offset += length;
  }
  return false;
}
