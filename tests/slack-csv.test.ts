import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadSlackFile,
  isSafeSlackFilename,
  selectSlackFileKind,
} from '../apps/gateway/src/slack-file.js';

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

describe('Slack PNG validation and download', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );
  const file = {
    name: 'fixture.png',
    mode: 'hosted',
    size: png.length,
    mimetype: 'image/png',
    url_private: 'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.png',
  };

  afterEach(() => vi.unstubAllGlobals());

  it('requires one small Slack-hosted PNG and returns its exact bytes', async () => {
    const request = vi.fn().mockResolvedValue(new Response(png));
    vi.stubGlobal('fetch', request);
    for (const files of [
      [file, file],
      [{ ...file, name: 'fixture.jpg' }],
      [{ ...file, mode: 'external' }],
      [{ ...file, mode: 'snippet' }],
      [{ ...file, is_external: true }],
      [{ ...file, mimetype: 'image/jpeg' }],
      [
        {
          ...file,
          url_private: 'https://files.slack.com.example/files-pri/fixture.png',
        },
      ],
    ])
      expect(await downloadSlackFile(files, 'synthetic-token', 'png')).toMatch(
        /one Slack-hosted PNG/,
      );
    expect(
      await downloadSlackFile(
        [{ ...file, size: 16 * 1024 + 1 }],
        'synthetic-token',
        'png',
      ),
    ).toMatch(/exceeds the 16 KiB limit/);
    expect(request).not.toHaveBeenCalled();
    expect(await downloadSlackFile([file], 'synthetic-token', 'png')).toEqual(
      png,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      new URL(file.url_private),
      expect.objectContaining({
        headers: { authorization: 'Bearer synthetic-token' },
        redirect: 'error',
      }),
    );
  });

  it('rejects invalid, incomplete, and oversized image headers', async () => {
    const wide = Buffer.from(png);
    wide.writeUInt32BE(1_025, 16);
    const tall = Buffer.from(png);
    tall.writeUInt32BE(1_025, 20);
    for (const bytes of [
      Buffer.alloc(png.length),
      png.subarray(0, -12),
      wide,
      tall,
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
      expect(
        await downloadSlackFile(
          [{ ...file, size: bytes.length }],
          'synthetic-token',
          'png',
        ),
      ).toMatch(/one Slack-hosted PNG/);
    }
  });
});

describe('Slack text and source validation', () => {
  const text = Buffer.from('export const total = 7;\n');
  const source = {
    name: 'fixture.ts',
    mode: 'hosted',
    size: text.length,
    mimetype: 'text/typescript',
    url_private: 'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.ts',
  };

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['notes.md', 'text/markdown'],
    ['review.diff', 'text/x-diff'],
    ['review.diff', 'application/octet-stream'],
    ['data.json', 'application/json'],
    ['fixture.ts', 'text/typescript'],
    ['fixture.ts', 'video/mp2t'],
    ['Dockerfile', 'text/plain'],
    ['README', 'text/plain'],
  ])(
    'classifies and downloads supported UTF-8 %s input',
    async (name, mimetype) => {
      const request = vi.fn().mockResolvedValue(new Response(text));
      vi.stubGlobal('fetch', request);
      const file = { ...source, name, mimetype };

      expect(selectSlackFileKind(file)).toBe('text');
      expect(
        await downloadSlackFile([file], 'synthetic-token', 'text'),
      ).toEqual(text);
    },
  );

  it('rejects unsafe names, unsupported types, NUL bytes, and invalid UTF-8', async () => {
    expect(isSafeSlackFilename('../fixture.ts')).toBe(false);
    expect(isSafeSlackFilename('nested/fixture.ts')).toBe(false);
    expect(isSafeSlackFilename('fixture.ts')).toBe(true);
    expect(isSafeSlackFilename('')).toBe(false);
    expect(isSafeSlackFilename('a'.repeat(121))).toBe(false);
    for (const file of [
      { ...source, name: '../fixture.ts' },
      { ...source, name: 'fixture.exe' },
      { ...source, mimetype: 'application/octet-stream' },
    ])
      expect(selectSlackFileKind(file)).toBeUndefined();

    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(Buffer.from([0x61, 0x00, 0x62])))
      .mockResolvedValueOnce(new Response(Buffer.from([0xff, 0xfe, 0xfd])));
    vi.stubGlobal('fetch', request);
    expect(
      await downloadSlackFile(
        [{ ...source, size: 3 }],
        'synthetic-token',
        'text',
      ),
    ).toMatch(/supported Slack-hosted UTF-8/);
    expect(
      await downloadSlackFile(
        [{ ...source, size: 3 }],
        'synthetic-token',
        'text',
      ),
    ).toMatch(/supported Slack-hosted UTF-8/);
  });

  it('accepts an exact UTF-8 HTML source despite its response content type', async () => {
    const html = Buffer.from('<main>Synthetic source</main>\n');
    const file = {
      ...source,
      name: 'fixture.html',
      size: html.length,
      mimetype: 'text/html',
      url_private:
        'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.html',
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(html, { headers: { 'content-type': 'text/html' } }),
        ),
    );

    expect(await downloadSlackFile([file], 'synthetic-token', 'text')).toEqual(
      html,
    );
  });
});

describe('Slack JPEG validation and download', () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
    0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0x00, 0xff, 0xd9,
  ]);
  const file = {
    name: 'fixture.jpg',
    mode: 'hosted',
    size: jpeg.length,
    mimetype: 'image/jpeg',
    url_private: 'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.jpg',
  };

  afterEach(() => vi.unstubAllGlobals());

  it.each(['fixture.jpg', 'fixture.jpeg'])(
    'classifies and downloads one bounded %s image',
    async (name) => {
      const request = vi.fn().mockResolvedValue(new Response(jpeg));
      vi.stubGlobal('fetch', request);
      const attachment = { ...file, name };

      expect(selectSlackFileKind(attachment)).toBe('jpeg');
      expect(
        await downloadSlackFile([attachment], 'synthetic-token', 'jpeg'),
      ).toEqual(jpeg);
    },
  );

  it.each(['baseline.jpg', 'progressive.jpg'])(
    'accepts a complete %s with JPEG metadata, tables, and image data',
    async (name) => {
      const bytes = readFileSync(
        new URL('./fixtures/file-exchange/' + name, import.meta.url),
      );
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
      const attachment = { ...file, name, size: bytes.length };
      await expect(
        downloadSlackFile([attachment], 'synthetic-token', 'jpeg'),
      ).resolves.toEqual(bytes);
    },
  );

  it('rejects truncated, malformed, oversized-dimension, and mislabelled JPEGs', async () => {
    const wide = Buffer.from(jpeg);
    wide.writeUInt16BE(1_025, 9);
    const malformed = Buffer.from(jpeg);
    malformed.writeUInt16BE(0xffff, 4);
    for (const bytes of [jpeg.subarray(0, -2), malformed, wide]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
      expect(
        await downloadSlackFile(
          [{ ...file, size: bytes.length }],
          'synthetic-token',
          'jpeg',
        ),
      ).toMatch(/one Slack-hosted JPEG/);
    }
    expect(selectSlackFileKind({ ...file, mode: 'snippet' })).toBeUndefined();
    expect(
      selectSlackFileKind({ ...file, mimetype: 'image/png' }),
    ).toBeUndefined();
  });
});
