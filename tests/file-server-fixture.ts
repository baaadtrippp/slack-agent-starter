import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

type Shared =
  typeof import('../apps/gateway/node_modules/@chat-adapter/shared/dist/index.js');
export type FileServer = (
  url: URL,
  headers?: Record<string, string>,
) => Promise<Response>;

// Use as a vi.mock factory result for @chat-adapter/shared: every
// downloadAttachment call reaches `server` instead of the network. Its URL,
// host, redirect, size and response checks still run; the DNS private-address
// refusal lives in the replaced transport and does not.
export function withFileServer(shared: Shared, server: FileServer): Shared {
  return {
    ...shared,
    downloadAttachment: (value, options) =>
      shared.downloadAttachment(value, {
        ...options,
        transport: async (url, _signal, headers) => {
          const response = await server(url, headers);
          const body = Buffer.from(await response.arrayBuffer());
          return Object.assign(Readable.from([body]), {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers),
          }) as unknown as IncomingMessage;
        },
      }),
  };
}
