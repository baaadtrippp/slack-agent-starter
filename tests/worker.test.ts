import { describe, expect, it, vi } from 'vitest';
import { CANNED_REPLY } from '../packages/contracts/src/index.js';
import { createFakeWorker } from '../apps/worker/src/fake-worker.js';

const now = 1_800_000_000_000;
const callbackToken = 'a'.repeat(64);

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: '11111111-1111-4111-8111-111111111111',
    conversationId: 'b'.repeat(64),
    generation: 1,
    input: {
      text: 'Please help with this task.',
      senderId: 'U00000001',
      workspaceId: 'T00000001',
      channelId: 'C00000001',
      threadTs: '1800000000.000001',
      messageTs: '1800000000.000002',
    },
    deadline: now + 30_000,
    callbackUrl: 'https://gateway.example/api/worker/callback',
    callbackToken,
    ...overrides,
  };
}

function request(body: unknown, token = callbackToken) {
  return new Request('https://worker.example/api/worker/fake', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeWorker(
  fetchRequest: typeof fetch,
  tasks: Array<Promise<unknown>> = [],
) {
  return createFakeWorker({
    origin: 'https://gateway.example',
    fetch: fetchRequest,
    waitUntil: (task) => tasks.push(task),
    now: () => now,
  });
}

describe('fake worker HTTP contract', () => {
  it('checks gateway admission before acknowledging a canned result', async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const tasks: Array<Promise<unknown>> = [];
    const response = await makeWorker(fetchRequest, tasks)(request(makeJob()));

    expect(response.status).toBe(202);
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(String(fetchRequest.mock.calls[0]?.[0])).toBe(
      'https://gateway.example/api/worker/callback?runId=11111111-1111-4111-8111-111111111111&generation=1',
    );
    expect(tasks).toHaveLength(1);
  });

  it('rejects mismatched bearer and job credentials before contacting the gateway', async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const response = await makeWorker(fetchRequest)(
      request(makeJob(), 'b'.repeat(64)),
    );

    expect(response.status).toBe(401);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('rejects expired jobs and deadlines beyond the clock-skew allowance', async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const handler = makeWorker(fetchRequest);

    const expired = await handler(request(makeJob({ deadline: now })));
    const tooFarAhead = await handler(
      request(makeJob({ deadline: now + 65_001 })),
    );

    expect(expired.status).toBe(400);
    expect(tooFarAhead.status).toBe(400);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it.each([
    'https://attacker.example/api/worker/callback',
    'https://gateway.example.evil/api/worker/callback',
    'https://user:pass@gateway.example/api/worker/callback',
    'https://gateway.example/api/worker/callback/extra',
  ])('rejects callback destination %s', async (callbackUrl) => {
    const fetchRequest = vi.fn<typeof fetch>();
    const response = await makeWorker(fetchRequest)(
      request(makeJob({ callbackUrl })),
    );

    expect(response.status).toBe(400);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized request bodies', async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const handler = makeWorker(fetchRequest);

    const malformed = await handler(request('{broken'));
    const oversized = await handler(request('x'.repeat(129 * 1024)));

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('does not schedule work unless the gateway admits this run', async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const tasks: Array<Promise<unknown>> = [];
    const response = await makeWorker(fetchRequest, tasks)(request(makeJob()));

    expect(response.status).toBe(403);
    expect(tasks).toHaveLength(0);
  });

  it.each([
    ['multibyte', 'あ'.repeat(12_000)],
    ['JSON-escaped', '\u0000'.repeat(12_000)],
  ])(
    'accepts maximum-length %s input within the worker job bound',
    async (_kind, text) => {
      const fetchRequest = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }));
      const tasks: Array<Promise<unknown>> = [];
      const job = makeJob();
      job.input.text = text;
      expect(Buffer.byteLength(JSON.stringify(job))).toBeGreaterThan(32 * 1024);
      const response = await makeWorker(fetchRequest, tasks)(request(job));
      expect(response.status).toBe(202);
      await Promise.all(tasks);
    },
  );

  it('reuses one result event across bounded retry attempts', async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const tasks: Array<Promise<unknown>> = [];
    const response = await makeWorker(fetchRequest, tasks)(request(makeJob()));

    expect(response.status).toBe(202);
    await Promise.all(tasks);

    expect(fetchRequest).toHaveBeenCalledTimes(3);
    const resultBodies = fetchRequest.mock.calls
      .slice(1)
      .map(
        (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
      );
    expect(resultBodies[0]).toEqual(resultBodies[1]);
    expect(resultBodies[0]).toMatchObject({
      runId: '11111111-1111-4111-8111-111111111111',
      text: CANNED_REPLY,
    });
  });

  it('returns after scheduling the callback, before it completes', async () => {
    let releaseCallback!: () => void;
    const callback = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce(() =>
        callback.then(() => new Response(null, { status: 202 })),
      );
    const tasks: Array<Promise<unknown>> = [];

    const response = await makeWorker(fetchRequest, tasks)(request(makeJob()));

    expect(response.status).toBe(202);
    expect(tasks).toHaveLength(1);
    expect(fetchRequest).toHaveBeenCalledTimes(2);

    releaseCallback();
    await Promise.all(tasks);
  });

  it('does not retry permanent callback failures', async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const tasks: Array<Promise<unknown>> = [];

    const response = await makeWorker(fetchRequest, tasks)(request(makeJob()));
    await Promise.all(tasks);

    expect(response.status).toBe(202);
    expect(fetchRequest).toHaveBeenCalledTimes(2);
  });
});
