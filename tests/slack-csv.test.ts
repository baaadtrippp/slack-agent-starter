import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSlackCsv } from '../apps/gateway/src/slack-csv.js';

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
      .mockResolvedValueOnce(new Response(Buffer.concat([csv, csv])))
      .mockResolvedValueOnce(new Response(csv.subarray(1)))
      .mockResolvedValueOnce(new Response(Buffer.alloc(csv.length, 0xff)));
    vi.stubGlobal('fetch', request);
    for (let response = 0; response < 3; response += 1)
      expect(await downloadSlackCsv([file], 'synthetic-token')).toMatch(
        /could not read/,
      );
    expect(await downloadSlackCsv([file], 'synthetic-token')).toMatch(/UTF-8/);
  });
});
