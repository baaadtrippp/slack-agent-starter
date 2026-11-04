import { isUtf8 } from 'node:buffer';
import { z } from 'zod';

const maxBytes = 16 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
const maxPngEdge = 1_024;
const csvMimetypes = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
];
const metadata = z.looseObject({
  mode: z.enum(['hosted', 'snippet']),
  is_external: z.literal(false).optional(),
  name: z.string(),
  mimetype: z.string(),
  size: z.number().int().positive(),
  url_private: z.url(),
});

export async function downloadSlackFile(
  files: unknown,
  token: string,
  kind: 'csv' | 'pdf' | 'png',
) {
  const label = kind.toUpperCase();
  const inaccessible = `I could not read the Slack file. Check that it is shared here and mention me again with the ${label}.`;
  const unsupported =
    kind === 'pdf'
      ? 'Attach one Slack-hosted text-based PDF file.'
      : kind === 'png'
        ? 'Attach one Slack-hosted PNG file up to 1,024 pixels on either edge.'
        : 'Attach one Slack-hosted CSV file encoded as UTF-8.';
  const oversized = `The ${label} exceeds the 16 KiB limit for this test. Attach a smaller file.`;

  if (!Array.isArray(files) || files.length !== 1) return unsupported;
  const parsed = metadata.safeParse(files[0]);
  if (!parsed.success) return unsupported;
  const file = parsed.data;
  const supported =
    kind === 'pdf'
      ? file.mode === 'hosted' &&
        /\.pdf$/i.test(file.name) &&
        file.mimetype === 'application/pdf'
      : kind === 'png'
        ? file.mode === 'hosted' &&
          /\.png$/i.test(file.name) &&
          file.mimetype === 'image/png'
        : /\.csv$/i.test(file.name) && csvMimetypes.includes(file.mimetype);
  if (!supported) return unsupported;
  if (file.size > maxBytes) return oversized;
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
        response.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('text/html')
      )
        return inaccessible;
      const bytes = Buffer.alloc(file.size);
      let offset = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > maxBytes - offset) return oversized;
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
  return width > 0 && width <= maxPngEdge && height > 0 && height <= maxPngEdge;
}
