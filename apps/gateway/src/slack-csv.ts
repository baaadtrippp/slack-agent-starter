import { z } from 'zod';

const maxBytes = 16 * 1024;
const inaccessible =
  'I could not read the Slack file. Check that it is shared here and mention me again with the CSV.';
const unsupported = 'Attach one Slack-hosted CSV file encoded as UTF-8.';
const oversized =
  'The CSV exceeds the 16 KiB limit for this test. Attach a smaller file.';

const csvMetadata = z.looseObject({
  mode: z.enum(['hosted', 'snippet']),
  is_external: z.literal(false).optional(),
  name: z.string().regex(/\.csv$/i),
  mimetype: z.enum([
    'text/csv',
    'application/csv',
    'text/plain',
    'application/vnd.ms-excel',
  ]),
  size: z.number().int().positive(),
  url_private: z.url(),
});

export async function downloadSlackCsv(files: unknown, token: string) {
  if (!Array.isArray(files) || files.length !== 1) return unsupported;
  const parsed = csvMetadata.safeParse(files[0]);
  if (!parsed.success) return unsupported;
  const file = parsed.data;
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
        response.headers.get('content-type')?.includes('text/html')
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
      if (bytes.includes(0)) return unsupported;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return unsupported;
      }
      return bytes;
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return inaccessible;
  }
}
