import { randomUUID } from 'node:crypto';
import {
  CANNED_REPLY,
  workerJobSchema,
} from '../../../packages/contracts/src/index.js';
import type {
  WorkerJob,
  WorkerResult,
} from '../../../packages/contracts/src/index.js';

const MAX_BODY_BYTES = 128 * 1024;
const MAX_FUTURE_MS = 65_000;
const ADMISSION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

type FakeWorkerOptions = {
  origin: string;
  fetch: typeof fetch;
  waitUntil: (task: Promise<unknown>) => void;
  now?: () => number;
};

export function createFakeWorker({
  origin,
  fetch: fetchRequest,
  waitUntil,
  now = Date.now,
}: FakeWorkerOptions): (request: Request) => Promise<Response> {
  const baseUrl = new URL(origin);
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new TypeError('Worker origin must be a bare HTTPS origin');
  }

  return async (request) => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'POST' },
      });
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return new Response('Unsupported media type', { status: 415 });
    }

    const body = await readBoundedJson(request);
    if (body instanceof Response) return body;

    const parsed = workerJobSchema.safeParse(body);
    if (!parsed.success)
      return new Response('Invalid worker job', { status: 400 });

    const job = parsed.data;
    // Both values are supplied by this request; the gateway check authenticates the capability.
    if (
      request.headers.get('authorization') !== `Bearer ${job.callbackToken}`
    ) {
      return new Response('Unauthorized', { status: 401 });
    }
    const currentTime = now();
    if (
      job.deadline <= currentTime ||
      job.deadline > currentTime + MAX_FUTURE_MS
    ) {
      return new Response('Worker job expired or has an invalid deadline', {
        status: 400,
      });
    }

    const callbackUrl = new URL(job.callbackUrl);
    if (
      callbackUrl.origin !== baseUrl.origin ||
      callbackUrl.pathname !== '/api/worker/callback' ||
      callbackUrl.search ||
      callbackUrl.hash ||
      callbackUrl.username ||
      callbackUrl.password
    ) {
      return new Response('Invalid callback destination', { status: 400 });
    }

    const authorizeUrl = new URL(callbackUrl);
    authorizeUrl.searchParams.set('runId', job.runId);
    authorizeUrl.searchParams.set('generation', String(job.generation));

    let authorization: Response;
    try {
      authorization = await fetchRequest(authorizeUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${job.callbackToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
      });
    } catch {
      return new Response('Gateway admission check failed', { status: 502 });
    }
    if (authorization.status !== 204) {
      return new Response('Worker job was not admitted', { status: 403 });
    }

    const result: WorkerResult = {
      version: 1,
      runId: job.runId,
      generation: job.generation,
      eventId: randomUUID(),
      sequence: 1,
      type: 'completed',
      text: CANNED_REPLY,
    };

    try {
      waitUntil(deliverResult(fetchRequest, callbackUrl, job, result));
    } catch {
      return new Response('Could not schedule worker result', { status: 503 });
    }

    return new Response(null, { status: 202 });
  };
}

async function readBoundedJson(request: Request): Promise<unknown | Response> {
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing request body', { status: 400 });

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return new Response('Request body too large', { status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }
}

async function deliverResult(
  fetchRequest: typeof fetch,
  callbackUrl: URL,
  job: WorkerJob,
  result: WorkerResult,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchRequest(callbackUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${job.callbackToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(result),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      continue;
    }

    if (response.ok || !isRetryableStatus(response.status)) return;
  }
  console.error(
    JSON.stringify({ runId: job.runId, phase: 'callback_delivery_failed' }),
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
