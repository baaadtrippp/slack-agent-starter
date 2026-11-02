import { waitUntil } from '@vercel/functions';
import { createFakeWorker } from './fake-worker.js';

export function POST(request: Request): Promise<Response> {
  const origin = process.env.GATEWAY_ORIGIN;
  if (!origin)
    throw new Error('GATEWAY_ORIGIN is required for the fake worker');
  return createFakeWorker({ origin, fetch, waitUntil })(request);
}
