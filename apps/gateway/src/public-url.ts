import { downloadAttachment, NetworkError } from '@chat-adapter/shared';

const invalid =
  'Send a direct public HTTPS link without credentials or a custom port.';
const unsupported = 'The URL must return UTF-8 plain text.';
const inaccessible =
  'I could not fetch that public URL. Check that it opens without signing in and does not redirect.';
const unexpectedType = new Error('Expected text/plain');

export async function fetchPublicText(value: string): Promise<Buffer | string> {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port
  )
    return invalid;

  let bytes;
  try {
    bytes = await downloadAttachment(url.href, {
      adapter: 'public-url',
      limit: 16 * 1024,
      timeoutMs: 8_000,
      redirects: 0,
      onResponse(response) {
        const type = response.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (type !== 'text/plain') throw unexpectedType;
      },
    });
  } catch (error) {
    if (error === unexpectedType) return unsupported;
    if (error instanceof NetworkError) {
      if (error.message.includes('internal attachment URL'))
        return 'That URL points to a private or restricted network address.';
      if (error.message.includes('exceeds the download limit'))
        return 'The URL response exceeds the 16 KiB limit for this test.';
      if (error.message.includes('Timed out'))
        return 'The public URL did not respond within 8 seconds.';
    }
    return inaccessible;
  }

  if (bytes.length === 0 || bytes.includes(0)) return unsupported;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return unsupported;
  }
  return bytes;
}
