import { once } from 'node:events';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import { createRedisState } from '@chat-adapter/state-redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { WorkerJob } from '../packages/contracts/src/index.js';

const { background, sandboxGet, driveGet, fetchPublicText } = vi.hoisted(
  () => ({
    background: [] as Promise<unknown>[],
    sandboxGet: vi.fn(),
    driveGet: vi.fn(),
    fetchPublicText: vi.fn(),
  }),
);
vi.mock('@vercel/functions', () => ({
  waitUntil: (task: Promise<unknown>) => background.push(task),
}));
vi.mock('../apps/gateway/node_modules/@vercel/sandbox/dist/index.js', () => ({
  Sandbox: { get: sandboxGet },
  Drive: { get: driveGet },
}));

vi.mock('../apps/gateway/src/public-url.js', () => ({ fetchPublicText }));

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('gateway runtime Redis recovery', () => {
  let server: net.Server | undefined;
  const sockets: Array<{ client: net.Socket; server: net.Socket }> = [];
  let stallReplies = false;
  let connections = 0;

  afterAll(async () => {
    for (const pair of sockets) {
      pair.client.destroy();
      pair.server.destroy();
    }
    if (server?.listening) {
      server.close();
      await once(server, 'close');
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reopens a dead runtime and bounds stalled Redis replies', async () => {
    const target = new URL(redisUrl!);
    expect(target.protocol).toBe('redis:');
    expect(target.hostname).toBe('127.0.0.1');
    server = net.createServer((client) => {
      connections += 1;
      const upstream = net.connect(Number(target.port), target.hostname);
      const pair = { client, server: upstream };
      sockets.push(pair);
      client.on('data', (chunk) => upstream.write(chunk));
      upstream.on('data', (chunk) => {
        if (!stallReplies) client.write(chunk);
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TCP proxy did not bind');

    vi.stubEnv('GATEWAY_ORIGIN', 'https://gateway.example');
    vi.stubEnv('FAKE_WORKER_URL', 'https://gateway.example/api/worker/fake');
    vi.stubEnv('SLACK_ENABLED_CHANNEL_IDS', 'CTEST1');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'synthetic-signing-secret');
    vi.stubEnv('SLACK_BOT_TOKEN', 'synthetic-bot-token');
    vi.stubEnv('SLACK_WORKSPACE_ID', 'TTEST1');
    vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${address.port}`);
    vi.resetModules();
    const { handle } = await import('../apps/gateway/src/runtime.js');

    const forged = await handle(
      new Request('https://gateway.example/api/slack/events', {
        method: 'POST',
        body: '{}',
      }),
      'events',
    );
    expect(forged.status).toBe(401);
    expect(connections).toBe(0);

    const request = () =>
      new Request(
        'https://gateway.example/api/worker/callback?runId=00000000-0000-4000-8000-000000000001&generation=1',
        {
          method: 'GET',
          headers: { authorization: `Bearer ${'f'.repeat(64)}` },
        },
      );
    const first = await handle(request(), 'callback');
    expect(first.status).toBe(401);
    expect(connections).toBe(1);

    const disconnected = sockets.map((pair) => once(pair.client, 'close'));
    for (const pair of sockets) {
      pair.client.destroy();
      pair.server.destroy();
    }
    await Promise.all(disconnected);

    const reopened = await retryUntil(async () => {
      const response = await handle(request(), 'callback');
      return response.status === 401 ? response : null;
    });
    expect(reopened.status).toBe(401);
    expect(connections).toBeGreaterThan(1);

    stallReplies = true;
    const started = performance.now();
    const stalled = await handle(request(), 'callback');
    expect(stalled.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(2_700);

    stallReplies = false;
    const recovered = await retryUntil(async () => {
      const response = await handle(request(), 'callback');
      return response.status === 401 ? response : null;
    });
    expect(recovered.status).toBe(401);
    expect(connections).toBeGreaterThan(2);

    vi.resetModules();
    const { handle: coldHandle } =
      await import('../apps/gateway/src/runtime.js');
    const beforeCold = connections;
    stallReplies = true;
    const coldStarted = performance.now();
    expect((await coldHandle(request(), 'callback')).status).toBe(503);
    expect(performance.now() - coldStarted).toBeLessThan(2_700);
    expect(connections).toBeGreaterThan(beforeCold);
    stallReplies = false;
    expect((await coldHandle(request(), 'callback')).status).toBe(401);
  }, 10_000);

  it('completes publication when Slack initialization and posting each take longer than one second', async () => {
    await configureRuntime(undefined, false);
    const { SlackAdapter } = await import('@chat-adapter/slack');
    const initialize = vi
      .spyOn(SlackAdapter.prototype, 'initialize')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 1_300)),
      );
    vi.spyOn(SlackAdapter.prototype, 'postMessage').mockImplementation(
      async (threadId) => {
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        return { id: '1800000001.000001', threadId, raw: {} };
      },
    );
    vi.spyOn(SlackAdapter.prototype, 'addReaction').mockResolvedValue();
    vi.spyOn(SlackAdapter.prototype, 'editMessage').mockResolvedValue({
      id: '1800000001.000001',
      threadId: 'slack:CTEST1:1800000000.000001',
      raw: {},
    });
    let job: WorkerJob | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        job = JSON.parse(String(init?.body)) as WorkerJob;
        return new Response(null, { status: 202 });
      }),
    );
    const { handle } = await import('../apps/gateway/src/runtime.js');
    const event = runtimeEvent();
    const observer = createRedisState({
      url: redisUrl!,
      keyPrefix: `runtime-observer:${randomUUID()}`,
    });
    await observer.connect();
    try {
      const response = await handle(event.request, 'events');
      expect(response.status).toBe(200);
      await drainBackground();
      expect(job).toBeDefined();
      expect(initialize).toHaveBeenCalledTimes(1);
      const callback = await handle(
        new Request('https://gateway.example/api/worker/callback', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${job!.callbackToken}`,
          },
          body: JSON.stringify({
            version: 1,
            runId: job!.runId,
            generation: 1,
            eventId: randomUUID(),
            sequence: 1,
            type: 'completed',
            text: 'Synthetic delayed Slack result',
          }),
        }),
        'callback',
      );
      expect(callback.status).toBe(202);
      await drainBackground();
      expect(initialize).toHaveBeenCalledTimes(1);
      const encoded = await observer
        .getClient()
        .get(`slack-agent:m1:run:${job!.runId}`);
      expect(JSON.parse(encoded!)).toMatchObject({
        state: 'completed',
        messageId: '1800000001.000001',
      });
    } finally {
      await cleanupRuntimeRun(observer, event);
      await observer.disconnect();
    }
  }, 10_000);

  const sandboxDispatchConditions = [
    'running',
    'managed idle',
    'stopped',
    'unrecordable',
    'stopping',
    'uncertain exit',
    'result missing',
    'start response lost',
  ] as const;

  it.each(sandboxDispatchConditions)(
    'uses the exact %s Sandbox session safely',
    async (condition) => {
      await configureRuntime('synthetic-worker');
      const observer = createRedisState({
        url: redisUrl!,
        keyPrefix: `runtime-sandbox-observer:${randomUUID()}`,
      });
      await observer.connect();
      const sessionId = randomUUID();
      const target = { sandboxName: 'synthetic-worker', sessionId };
      const { RedisRunStore } = await import('../apps/gateway/src/store.js');
      const store = new RedisRunStore(observer.getClient());
      const operationId = randomUUID();
      const startResponseLost = condition === 'start response lost';
      const managed = condition === 'managed idle';
      const hasResult = condition === 'running' || managed;
      const driveName = 'synthetic-drive';
      const seedId = 'synthetic-seed';
      if (managed) {
        vi.stubEnv('SANDBOX_MANAGED_DRIVE', driveName);
        vi.stubEnv('SANDBOX_MANAGED_SEED', seedId);
        driveGet.mockResolvedValue({
          name: driveName,
          driveId: 'synthetic-drive-id',
          currentSessionId: sessionId,
          currentSandboxName: target.sandboxName,
        });
      }
      expect(await store.enrollIdleSession(target)).toBe(true);
      if (condition === 'stopping')
        expect(await store.claimIdleStop(target, operationId)).toBe('claimed');
      let recorded: unknown;
      let job: WorkerJob;
      const commandWait = vi.fn().mockImplementation(async () => {
        expect(await store.claimIdleStop(target, operationId)).toBe('active');
        if (hasResult)
          expect(
            await store.claimPublication(
              job.runId,
              {
                version: 1,
                runId: job.runId,
                generation: 1,
                eventId: randomUUID(),
                sequence: 1,
                type: 'completed',
                text: 'Synthetic terminal result',
              },
              Date.now(),
            ),
          ).toBe('claimed');
        return { exitCode: condition === 'uncertain exit' ? 1 : 0 };
      });
      const sessionRunCommand = vi.fn().mockImplementation(async (command) => {
        job = JSON.parse(command.env.HYDRA_JOB) as WorkerJob;
        const encoded = await observer
          .getClient()
          .get(`slack-agent:m1:run:${job.runId}`);
        recorded = JSON.parse(encoded!);
        if (startResponseLost)
          throw new Error('Synthetic command start response lost');
        return { wait: commandWait };
      });
      const sandboxRunCommand = vi.fn();
      const sessionStop = vi.fn().mockResolvedValue(undefined);
      const readiness = vi.fn().mockResolvedValue({ exitCode: 0 });
      sandboxGet.mockResolvedValue({
        runCommand: sandboxRunCommand,
        persistent: false,
        currentSnapshotId: seedId,
        mounts: { '/workspace': { mode: 'read-write', drive: driveName } },
        currentSession: () => ({
          status: condition === 'stopped' ? 'stopped' : 'running',
          sessionId,
          sourceSnapshotId: seedId,
          runCommand: (command: { cmd: string }) =>
            command.cmd === 'bash'
              ? readiness(command)
              : sessionRunCommand(command),
          stop: sessionStop,
        }),
      });
      if (condition === 'unrecordable')
        vi.spyOn(
          RedisRunStore.prototype,
          'recordDispatchTarget',
        ).mockResolvedValue('conflict');
      const event = runtimeEvent();
      let runId: string | undefined;
      try {
        const { handle } = await import('../apps/gateway/src/runtime.js');
        expect((await handle(event.request, 'events')).status).toBe(200);
        await drainBackground();
        runId =
          (await observer
            .getClient()
            .get(`slack-agent:m1:event:TTEST1:${event.eventId}`)) ?? undefined;
        expect(runId).toBeDefined();
        const encoded = await observer
          .getClient()
          .get(`slack-agent:m1:run:${runId}`);
        expect(sandboxGet).toHaveBeenCalledWith({
          name: 'synthetic-worker',
          resume: false,
          signal: expect.any(AbortSignal),
        });
        expect(sandboxRunCommand).not.toHaveBeenCalled();
        if (
          hasResult ||
          condition === 'uncertain exit' ||
          condition === 'result missing' ||
          startResponseLost
        ) {
          expect(JSON.parse(encoded!)).toMatchObject({
            state: startResponseLost
              ? 'dispatch_failed'
              : hasResult
                ? 'publishing'
                : 'accepted',
            execution: target,
          });
          expect(recorded).toMatchObject({
            state: 'accepted',
            execution: target,
          });
          expect(sessionRunCommand).toHaveBeenCalledTimes(1);
          expect(commandWait).toHaveBeenCalledTimes(startResponseLost ? 0 : 1);
          expect(await store.claimIdleStop(target, operationId)).toBe(
            managed
              ? 'stopping'
              : condition === 'running'
                ? 'claimed'
                : 'active',
          );
        } else {
          expect(JSON.parse(encoded!)).toMatchObject({
            state:
              condition === 'unrecordable'
                ? 'dispatch_failed'
                : 'worker_failed',
          });
          expect(JSON.parse(encoded!)).not.toHaveProperty('execution');
          expect(sessionRunCommand).not.toHaveBeenCalled();
        }
        expect(readiness).toHaveBeenCalledTimes(managed ? 1 : 0);
        expect(sessionStop).toHaveBeenCalledTimes(managed ? 1 : 0);
      } finally {
        await cleanupRuntimeRun(observer, event, runId);
        const key = `slack-agent:m1:idle:synthetic-worker:${sessionId}`;
        await observer.getClient().del([key + ':gate', key + ':active']);
        if (managed)
          await observer
            .getClient()
            .del('slack-agent:m1:runtime:synthetic-worker:managed');
        await observer.disconnect();
        vi.restoreAllMocks();
      }
    },
  );

  const stagingOutcomes = [
    'staged CSV',
    'staged CSV and URL',
    'staged URL',
    'staged bare IPv6 URL',
    'staged explicit IPv6 URL with period',
    'staged uppercase explicit IPv6 URL with period',
    'staged bare IPv6 URL with comma-shaped query data',
    'staged bare URL with balanced parentheses',
    'staged PDF',
    'staged PNG with all file types enabled',
    'staged PDF with CSV enabled',
    'write failed',
    'expired during staging',
  ] as const;

  it.each(stagingOutcomes)(
    'handles %s before Sandbox worker launch',
    async (outcome) => {
      await configureRuntime('synthetic-worker');
      const bareIpv6 = outcome === 'staged bare IPv6 URL';
      const explicitIpv6 = outcome === 'staged explicit IPv6 URL with period';
      const uppercaseExplicitIpv6 =
        outcome === 'staged uppercase explicit IPv6 URL with period';
      const commaQueryIpv6 =
        outcome === 'staged bare IPv6 URL with comma-shaped query data';
      const balancedUrl =
        outcome === 'staged bare URL with balanced parentheses';
      const url = balancedUrl
        ? 'https://example.com/methodology_(v1)'
        : bareIpv6
          ? 'https://[2001:4860:4860::8888]/source.txt'
          : commaQueryIpv6
            ? 'https://[2001:4860:4860::8888]/source.txt?next=alpha,https://[2606:4700:4700::1111]/other.txt'
            : uppercaseExplicitIpv6
              ? 'HTTPS://[2001:4860:4860::8888]/source.txt.'
              : explicitIpv6
                ? 'https://[2001:4860:4860::8888]/source.txt.'
                : 'https://example.com/source.txt?a=1&b=2';
      const slackUrl =
        explicitIpv6 || uppercaseExplicitIpv6
          ? url
          : 'https://example.com/source.txt?a=1&amp;b=2';
      const isMixed = outcome === 'staged CSV and URL';
      const isUrl =
        outcome === 'staged URL' ||
        balancedUrl ||
        bareIpv6 ||
        commaQueryIpv6 ||
        explicitIpv6 ||
        uppercaseExplicitIpv6;
      const isPdf = outcome.startsWith('staged PDF');
      const isPng = outcome.startsWith('staged PNG');
      const kind = isUrl ? 'publicUrl' : isPng ? 'png' : isPdf ? 'pdf' : 'csv';
      const isStaged =
        isMixed || outcome === 'staged CSV' || isUrl || isPdf || isPng;
      const content = isUrl
        ? 'Synthetic text source.\n'
        : isPdf
          ? '%PDF-1.4\nSynthetic transfer bytes only.\n'
          : isPng
            ? Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
                'base64',
              )
            : 'region,amount\nNorth,12\nSouth,18\n';
      vi.stubEnv('SLACK_PUBLIC_URL_INPUT', isUrl || isMixed ? '1' : '0');
      vi.stubEnv('SLACK_FILE_EXCHANGE', isMixed ? '1' : '0');
      vi.stubEnv('SLACK_PDF_INPUT', isPdf || isPng ? '1' : '0');
      vi.stubEnv('SLACK_PNG_INPUT', isPng ? '1' : '0');
      vi.stubEnv(
        'SLACK_CSV_INPUT',
        kind === 'csv' || isPng || outcome === 'staged PDF with CSV enabled'
          ? '1'
          : '0',
      );
      const urlBytes = Buffer.from(
        isMixed ? 'Use the sum of amounts.\n' : content,
      );
      fetchPublicText.mockResolvedValue(urlBytes);
      const download = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(content));
      vi.stubGlobal('fetch', download);
      const observer = createRedisState({ url: redisUrl! });
      await observer.connect();
      const sessionId = randomUUID();
      const target = { sandboxName: 'synthetic-worker', sessionId };
      const { RedisRunStore } = await import('../apps/gateway/src/store.js');
      const store = new RedisRunStore(observer.getClient());
      let staged = false;
      const writeFiles = vi.fn().mockImplementation(async () => {
        if (outcome === 'write failed') throw new Error('Synthetic fault');
        if (outcome === 'expired during staging')
          vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        staged = true;
      });
      let job: WorkerJob | undefined;
      let stagedBeforeLaunch = false;
      const runCommand = vi.fn().mockImplementation(async (command) => {
        stagedBeforeLaunch = staged;
        job = JSON.parse(command.env.HYDRA_JOB) as WorkerJob;
        return { wait: async () => ({ exitCode: 1 }) };
      });
      sandboxGet.mockResolvedValue({
        currentSession: () => ({
          status: 'running',
          sessionId,
          writeFiles,
          runCommand,
        }),
      });
      const { SlackAdapter } = await import('@chat-adapter/slack');
      vi.spyOn(SlackAdapter.prototype, 'initialize').mockResolvedValue();
      const postMessage = vi
        .spyOn(SlackAdapter.prototype, 'postMessage')
        .mockImplementation(async (threadId) => ({
          id: '1800000001.000001',
          threadId,
          raw: {},
        }));
      const event = runtimeEvent(
        isUrl
          ? {
              text: bareIpv6
                ? '<@UBOT1> Read https://[2001:4860:4860::8888]/source.txt.'
                : balancedUrl
                  ? '<@UBOT1> Read (' + url + ').'
                  : commaQueryIpv6
                    ? `<@UBOT1> Read ${url}`
                    : explicitIpv6 || uppercaseExplicitIpv6
                      ? `<@UBOT1> Read <${slackUrl}>.`
                      : `<@UBOT1> Read <${slackUrl}|the source>.`,
            }
          : {
              files: [
                syntheticSlackFile(
                  Buffer.byteLength(content),
                  isPng ? 'png' : isPdf ? 'pdf' : 'csv',
                ),
              ],
              ...(isStaged ? { subtype: 'file_share' } : {}),
              ...(isMixed
                ? { text: '<@UBOT1> Compare the CSV with <' + slackUrl + '>.' }
                : {}),
            },
      );
      let runId: string | undefined;
      try {
        expect(await store.enrollIdleSession(target)).toBe(true);
        const { handle } = await import('../apps/gateway/src/runtime.js');
        expect((await handle(event.request, 'events')).status).toBe(200);
        expect(fetchPublicText).not.toHaveBeenCalled();
        await drainBackground();
        if (isUrl || isMixed)
          expect(fetchPublicText).toHaveBeenCalledExactlyOnceWith(url);
        runId =
          (await observer
            .getClient()
            .get(`slack-agent:m1:event:TTEST1:${event.eventId}`)) ?? undefined;
        expect(runId).toBeDefined();
        expect(writeFiles).toHaveBeenCalledExactlyOnceWith(
          [
            {
              path: '/workspace/inputs/' + runId + '/' + runId + '/input-0',
              content: Buffer.from(content),
              mode: 0o600,
            },
            ...(isMixed
              ? [
                  {
                    path:
                      '/workspace/inputs/' + runId + '/' + runId + '/input-1',
                    content: urlBytes,
                    mode: 0o600,
                  },
                ]
              : []),
          ],
          { signal: expect.anything() },
        );
        if (isStaged) {
          expect(runCommand).toHaveBeenCalledTimes(1);
          expect(stagedBeforeLaunch).toBe(true);
          expect(job?.input.sources).toMatchObject([
            {
              kind,
              sha256: createHash('sha256').update(content).digest('hex'),
            },
            ...(isMixed
              ? [
                  {
                    kind: 'publicUrl',
                    name: 'Public URL text',
                    sha256: createHash('sha256').update(urlBytes).digest('hex'),
                  },
                ]
              : []),
          ]);
          if (isMixed) expect(job?.artifactOutput).toBe(true);
          expect(postMessage).toHaveBeenCalledExactlyOnceWith(
            `slack:CTEST1:${event.ts}`,
            'Starting…',
          );
        } else {
          expect(runCommand).not.toHaveBeenCalled();
          expect(await store.claimIdleStop(target, randomUUID())).toBe(
            'claimed',
          );
          expect(await store.getRun(runId!)).toMatchObject({
            state: 'worker_failed',
          });
          expect(postMessage).toHaveBeenLastCalledWith(
            `slack:CTEST1:${event.ts}`,
            'The inputs could not be staged. Resend the message with its files and links to retry.',
          );
        }
      } finally {
        await cleanupRuntimeRun(observer, event, runId);
        const key = `slack-agent:m1:idle:synthetic-worker:${sessionId}`;
        await observer.getClient().del([key + ':gate', key + ':active']);
        await observer.disconnect();
        vi.restoreAllMocks();
      }
    },
  );
});

async function drainBackground() {
  while (background.length > 0) await Promise.all(background.splice(0));
}

async function retryUntil<T>(action: () => Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    const result = await action();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Runtime did not recover before the test deadline');
}

async function configureRuntime(sandboxName?: string, mockSlack = true) {
  background.splice(0);
  sandboxGet.mockReset();
  driveGet.mockReset();
  vi.stubEnv('GATEWAY_ORIGIN', 'https://gateway.example');
  vi.stubEnv('SANDBOX_WORKER_NAME', sandboxName ?? '');
  vi.stubEnv('SANDBOX_MANAGED_DRIVE', '');
  vi.stubEnv('SANDBOX_MANAGED_SEED', '');
  if (sandboxName) vi.stubEnv('OPENROUTER_MODEL', 'synthetic/model');
  else vi.stubEnv('FAKE_WORKER_URL', 'https://worker.example/api/fake');
  vi.stubEnv('SLACK_ENABLED_CHANNEL_IDS', 'CTEST1');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'synthetic-signing-secret');
  vi.stubEnv('SLACK_BOT_TOKEN', 'synthetic-bot-token');
  vi.stubEnv('SLACK_WORKSPACE_ID', 'TTEST1');
  vi.stubEnv('REDIS_URL', redisUrl!);
  vi.resetModules();
  if (mockSlack) {
    const { SlackAdapter } = await import('@chat-adapter/slack');
    vi.spyOn(SlackAdapter.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(SlackAdapter.prototype, 'postMessage').mockImplementation(
      async (threadId) => ({
        id: '1800000001.000001',
        threadId,
        raw: {},
      }),
    );
    vi.spyOn(SlackAdapter.prototype, 'addReaction').mockResolvedValue();
    vi.spyOn(SlackAdapter.prototype, 'editMessage').mockResolvedValue({
      id: '1800000001.000001',
      threadId: 'slack:CTEST1:1800000000.000001',
      raw: {},
    });
  }
}

function runtimeEvent(options?: {
  files?: unknown[];
  subtype?: string;
  text?: string;
}) {
  const ts = `${Math.floor(Date.now() / 1_000)}.${String(
    Math.floor(Math.random() * 1_000_000),
  ).padStart(6, '0')}`;
  const eventId = `Ev${randomUUID()}`;
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TTEST1',
    event_id: eventId,
    is_ext_shared_channel: false,
    event: {
      type: 'app_mention',
      user: 'UTEST1',
      channel: 'CTEST1',
      text: options?.text ?? '<@UBOT1> Synthetic Sandbox dispatch test',
      ts,
      ...(options?.files ? { files: options.files } : {}),
      ...(options?.subtype ? { subtype: options.subtype } : {}),
    },
  });
  const stamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac('sha256', 'synthetic-signing-secret')
    .update(`v0:${stamp}:${body}`)
    .digest('hex');
  return {
    eventId,
    ts,
    request: new Request('https://gateway.example/api/slack/events', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': stamp,
        'x-slack-signature': `v0=${signature}`,
      },
    }),
  };
}

function syntheticSlackFile(size: number, kind: 'csv' | 'pdf' | 'png') {
  return {
    id: 'FTEST1',
    name: `test.${kind}`,
    mode: 'hosted',
    mimetype:
      kind === 'png'
        ? 'image/png'
        : kind === 'pdf'
          ? 'application/pdf'
          : 'text/csv',
    size,
    url_private: `https://files.slack.com/files-pri/TTEST1-FTEST1/test.${kind}`,
  };
}

async function cleanupRuntimeRun(
  observer: ReturnType<typeof createRedisState>,
  event: { eventId: string; ts: string },
  knownRunId?: string,
) {
  const client = observer.getClient();
  const eventKey = `slack-agent:m1:event:TTEST1:${event.eventId}`;
  const runId = knownRunId ?? (await client.get(eventKey));
  const keys = [
    eventKey,
    `slack-agent:m1:message:TTEST1:CTEST1:${event.ts}`,
    `slack-agent:m1:owner:TTEST1:CTEST1:${event.ts}`,
  ];
  if (runId) keys.push(`slack-agent:m1:run:${runId}`);
  await client.del(keys);
}
