import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Shared =
  typeof import('../apps/gateway/node_modules/@chat-adapter/shared/dist/index.js');
type Downloader = Shared['downloadAttachment'];
type AttachmentTransport = Parameters<Downloader>[1]['transport'];

const shared = vi.hoisted(() => ({
  downloadAttachment: vi.fn(),
  realDownloadAttachment: undefined as Downloader | undefined,
  NetworkError: undefined as Shared['NetworkError'] | undefined,
}));

vi.mock(
  '../apps/gateway/node_modules/@chat-adapter/shared/dist/index.js',
  async (importOriginal) => {
    const original = await importOriginal<Shared>();
    shared.realDownloadAttachment = original.downloadAttachment;
    shared.NetworkError = original.NetworkError;
    return {
      ...original,
      downloadAttachment: (...args: Parameters<Downloader>) =>
        shared.downloadAttachment(...args),
    };
  },
);

import { fetchPublicText } from '../apps/gateway/src/public-url.js';

function response(contentType: string): IncomingMessage {
  return {
    headers: { 'content-type': contentType },
  } as IncomingMessage;
}

function streamResponse(
  body: Buffer,
  statusCode: number,
  headers: IncomingMessage['headers'],
): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    statusCode,
    headers,
  }) as IncomingMessage;
}

function useRealDownloader(transport?: AttachmentTransport) {
  shared.downloadAttachment.mockImplementation((value, options) => {
    if (!shared.realDownloadAttachment)
      throw new Error('Real downloader was not loaded');
    return shared.realDownloadAttachment(value, { ...options, transport });
  });
}

describe('public text URL fetch', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    shared.downloadAttachment.mockReset();
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('downloads a direct HTTPS URL with the fixed safety limits', async () => {
    const body = Buffer.from('label,cents\nblue,123\n');
    shared.downloadAttachment.mockImplementation(async (_value, options) => {
      options.onResponse?.(response('Text/Plain; charset="UTF-8"'));
      return body;
    });

    await expect(
      fetchPublicText('https://example.com:443/fixture.txt'),
    ).resolves.toEqual(body);
    expect(shared.downloadAttachment).toHaveBeenCalledWith(
      'https://example.com/fixture.txt',
      expect.objectContaining({
        limit: 16 * 1024,
        timeoutMs: 8_000,
        redirects: 0,
        onResponse: expect.any(Function),
      }),
    );
  });

  it.each([
    'http://example.com/fixture.txt',
    'https://person:secret@example.com/fixture.txt',
    'https://example.com:444/fixture.txt',
  ])('rejects a non-direct public URL before download: %s', async (value) => {
    await expect(fetchPublicText(value)).resolves.toMatch(
      /direct public HTTPS/,
    );
    expect(shared.downloadAttachment).not.toHaveBeenCalled();
  });

  it.each([
    ['application/json', Buffer.from('{}')],
    ['text/plain; charset=windows-1252', Buffer.from('plain ASCII')],
    ['text/plain', Buffer.from([0xff])],
  ])(
    'rejects an unsupported response type or encoding: %s',
    async (type, body) => {
      shared.downloadAttachment.mockImplementation(async (_value, options) => {
        options.onResponse?.(response(type));
        return body;
      });

      await expect(
        fetchPublicText('https://example.com/fixture.txt'),
      ).resolves.toMatch(/UTF-8 plain text/);
    },
  );

  it.each([
    ['Attachment exceeds the download limit', /16 KiB/],
    ['Timed out fetching the attachment', /8 seconds/],
  ])('maps downloader failure %s', async (message, expected) => {
    if (!shared.NetworkError) throw new Error('NetworkError was not loaded');
    shared.downloadAttachment.mockRejectedValue(
      new shared.NetworkError('public-url', message),
    );

    await expect(
      fetchPublicText('https://example.com/fixture.txt'),
    ).resolves.toMatch(expected);
  });

  it.each([
    'https://127.0.0.1/fixture.txt',
    'https://[::1]/fixture.txt',
    'https://[::ffff:127.0.0.1]/fixture.txt',
    'https://localhost/fixture.txt',
  ])(
    'uses the real downloader to reject private destination %s',
    async (value) => {
      useRealDownloader();

      await expect(fetchPublicText(value)).resolves.toMatch(
        /private or restricted/,
      );
    },
  );

  it('does not follow a redirect to a private destination', async () => {
    const transport = vi.fn().mockResolvedValue(
      streamResponse(Buffer.alloc(0), 302, {
        location: 'https://127.0.0.1/fixture.txt',
      }),
    );
    useRealDownloader(transport);

    await expect(
      fetchPublicText('https://example.com/fixture.txt'),
    ).resolves.toMatch(/could not fetch/);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('reports the HTTP status a site answered and logs only its host', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(streamResponse(Buffer.alloc(0), 429, {}));
    useRealDownloader(transport);

    await expect(
      fetchPublicText(
        'https://files.example/notes.txt?key=value',
        'run-synthetic',
      ),
    ).resolves.toBe('The public URL answered HTTP 429 instead of the text.');
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        runId: 'run-synthetic',
        phase: 'public_url_unavailable',
        host: 'files.example',
        error: 'Failed to fetch file: 429',
        code: 'NETWORK_ERROR',
      }),
    );
  });

  it('logs a connection failure and keeps the generic reply', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
    useRealDownloader(transport);

    await expect(
      fetchPublicText('https://files.example/notes.txt', 'run-synthetic'),
    ).resolves.toMatch(/could not fetch/);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        runId: 'run-synthetic',
        phase: 'public_url_unavailable',
        host: 'files.example',
        error: 'socket hang up',
        code: 'ECONNRESET',
      }),
    );
  });

  it('applies the byte limit after decompressing a response', async () => {
    const transport = vi.fn().mockResolvedValue(
      streamResponse(gzipSync(Buffer.alloc(16 * 1024 + 1, 'a')), 200, {
        'content-encoding': 'gzip',
        'content-type': 'text/plain; charset=utf-8',
      }),
    );
    useRealDownloader(transport);

    await expect(
      fetchPublicText('https://example.com/fixture.txt'),
    ).resolves.toMatch(/16 KiB/);
    expect(transport).toHaveBeenCalledOnce();
  });
});
