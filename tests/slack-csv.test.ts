import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSlackFile } from '../apps/gateway/src/slack-file.js';

const downloadSlackCsv = (files: unknown, token: string) =>
  downloadSlackFile(files, token, 'csv');

const csv = Buffer.from('label,cents\nblue,123\n');
const file = {
  name: 'fixture.csv',
  mode: 'hosted',
  size: csv.length,
  mimetype: 'text/csv',
  url_private: 'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.csv',
};

describe('Slack CSV validation and download', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['hosted', 'snippet'])(
    'downloads exact bytes for a Slack %s file',
    async (mode) => {
      const request = vi.fn().mockResolvedValue(new Response(csv));
      vi.stubGlobal('fetch', request);
      expect(
        await downloadSlackCsv([{ ...file, mode }], 'synthetic-token'),
      ).toEqual(csv);
      expect(request).toHaveBeenCalledWith(
        new URL(file.url_private),
        expect.objectContaining({
          headers: { authorization: 'Bearer synthetic-token' },
          redirect: 'error',
        }),
      );
    },
  );

  it('rejects external, unsupported, multiple and oversized files before download', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    for (const files of [
      [{ ...file, mode: 'external' }],
      [{ ...file, url_private: 'https://files.slack.com.example/fixture.csv' }],
      [{ ...file, mimetype: 'image/png' }],
      [file, file],
    ])
      expect(await downloadSlackCsv(files, 'synthetic-token')).toMatch(
        /one Slack-hosted CSV/,
      );
    expect(
      await downloadSlackCsv(
        [{ ...file, size: 16 * 1024 + 1 }],
        'synthetic-token',
      ),
    ).toMatch(/exceeds the 16 KiB limit/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects inaccessible, mismatched and non-UTF-8 bodies', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(csv, { headers: { 'content-type': 'Text/HTML' } }),
      )
      .mockResolvedValueOnce(new Response(Buffer.concat([csv, csv])))
      .mockResolvedValueOnce(new Response(csv.subarray(1)))
      .mockResolvedValueOnce(new Response(Buffer.alloc(csv.length, 0xff)));
    vi.stubGlobal('fetch', request);
    for (let response = 0; response < 4; response += 1)
      expect(await downloadSlackCsv([file], 'synthetic-token')).toMatch(
        /could not read/,
      );
    expect(await downloadSlackCsv([file], 'synthetic-token')).toMatch(/UTF-8/);
  });
});

describe('Slack PDF validation and download', () => {
  const pdf = Buffer.from('%PDF-1.4\nSynthetic transfer bytes only.\n');
  const attachment = {
    name: 'fixture.pdf',
    mode: 'hosted',
    size: pdf.length,
    mimetype: 'application/pdf',
    url_private: 'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.pdf',
  };

  afterEach(() => vi.unstubAllGlobals());

  it('checks metadata and downloads the exact bytes without following redirects', async () => {
    const request = vi.fn().mockResolvedValue(new Response(pdf));
    vi.stubGlobal('fetch', request);
    for (const files of [
      [attachment, attachment],
      [{ ...attachment, name: 'fixture.txt' }],
      [{ ...attachment, mimetype: 'image/png' }],
      [
        {
          ...attachment,
          url_private: 'https://files.slack.com.example/files-pri/fixture.pdf',
        },
      ],
      [{ ...attachment, is_external: true }],
    ])
      expect(await downloadSlackFile(files, 'synthetic-token', 'pdf')).toMatch(
        /one Slack-hosted text-based PDF/,
      );
    expect(
      await downloadSlackFile(
        [{ ...attachment, size: 16 * 1024 + 1 }],
        'synthetic-token',
        'pdf',
      ),
    ).toMatch(/exceeds the 16 KiB limit/);
    expect(request).not.toHaveBeenCalled();
    expect(
      await downloadSlackFile([attachment], 'synthetic-token', 'pdf'),
    ).toEqual(pdf);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      new URL(attachment.url_private),
      expect.objectContaining({
        headers: { authorization: 'Bearer synthetic-token' },
        redirect: 'error',
      }),
    );
  });

  it('rejects inaccessible, truncated, and mislabelled documents', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(new Response(pdf.subarray(1)))
      .mockResolvedValueOnce(new Response(Buffer.alloc(pdf.length, 0x2e)));
    vi.stubGlobal('fetch', request);
    expect(
      await downloadSlackFile([attachment], 'synthetic-token', 'pdf'),
    ).toMatch(/could not read/);
    expect(
      await downloadSlackFile([attachment], 'synthetic-token', 'pdf'),
    ).toMatch(/could not read/);
    expect(
      await downloadSlackFile([attachment], 'synthetic-token', 'pdf'),
    ).toMatch(/text-based PDF/);
  });
});
