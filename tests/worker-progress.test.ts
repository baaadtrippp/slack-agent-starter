import { describe, expect, it, vi } from 'vitest';
import { workerResultSchema } from '../packages/contracts/src/index.js';

// The Sandbox entry point is plain JavaScript because it is copied directly
// into the worker image.
// @ts-expect-error No declaration file is shipped for the Sandbox entry point.
import * as sandboxWorker from '../apps/worker/sandbox/run.mjs';

const {
  artifactOutcome,
  consumeTurn,
  durableProviderQuota,
  isProviderQuotaSignal,
  recoverDriveWriteFailure,
  runUsage,
  workerFailureCategory,
} = sandboxWorker;

type TurnEvent =
  | { type: 'status'; text: string }
  | { type: 'text_delta'; text: string; stream?: 'output' | 'thought' }
  | { type: 'tool_call'; text: string; rawInput?: unknown }
  | {
      type: 'error';
      message: string;
      code?: string;
      detailCode?: string;
      retryable?: boolean;
    };

function controlledTurn(
  events: TurnEvent[],
  result:
    | { status: 'completed' }
    | {
        status: 'failed';
        error: {
          message: string;
          code?: string;
          detailCode?: string;
          retryable?: boolean;
        };
      } = { status: 'completed' },
) {
  return {
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    result: Promise.resolve(result),
  };
}

describe('Sandbox worker progress', () => {
  it('accepts bounded categories only on failed worker results', () => {
    const result = {
      version: 1,
      runId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      eventId: '00000000-0000-4000-8000-000000000002',
      sequence: 2,
      type: 'failed',
      text: 'Safe failure',
    } as const;
    expect(
      workerResultSchema.safeParse({
        ...result,
        failureCategory: 'provider_quota',
      }).success,
    ).toBe(true);
    expect(
      workerResultSchema.safeParse({
        ...result,
        type: 'completed',
        failureCategory: 'drive_full',
      }).success,
    ).toBe(false);
    expect(
      workerResultSchema.safeParse({
        ...result,
        failureCategory: 'private_provider_error',
      }).success,
    ).toBe(false);
  });

  it('accepts a refused file only on a completed result without a file', () => {
    const result = {
      version: 1,
      runId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      eventId: '00000000-0000-4000-8000-000000000002',
      sequence: 2,
      type: 'completed',
      text: 'Answer',
      artifactRefused: true,
    } as const;
    expect(workerResultSchema.safeParse(result).success).toBe(true);
    expect(
      workerResultSchema.safeParse({ ...result, type: 'failed' }).success,
    ).toBe(false);
    expect(
      workerResultSchema.safeParse({
        ...result,
        artifact: { sha256: 'a'.repeat(64) },
      }).success,
    ).toBe(false);
  });

  it('accepts optional bounded usage on a worker result', () => {
    const result = {
      version: 1,
      runId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      eventId: '00000000-0000-4000-8000-000000000002',
      sequence: 2,
      type: 'completed',
      text: 'Answer',
    } as const;
    for (const usage of [undefined, { tokens: 150 }, { tokens: 1, cost: 0 }])
      expect(workerResultSchema.safeParse({ ...result, usage }).success).toBe(
        true,
      );
    for (const usage of [
      { tokens: 0 },
      { tokens: 1.5 },
      { tokens: 150, cost: -0.01 },
      // A NaN cost arrives as null after JSON serialization.
      { tokens: 150, cost: null },
      { tokens: 150, model: 'synthetic' },
      { cost: 0.01 },
    ])
      expect(workerResultSchema.safeParse({ ...result, usage }).success).toBe(
        false,
      );
  });

  it('sums this turn’s model usage and keeps only a provider-billed cost', () => {
    const usage = (total: number, totalFromProvider?: boolean) => ({
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 150,
      cost: {
        input: 0.0001,
        output: 0.0002,
        cacheRead: 0,
        cacheWrite: 0,
        total,
        ...(totalFromProvider === undefined ? {} : { totalFromProvider }),
      },
    });
    const message = (role: string, value?: object) => ({
      type: 'message',
      message: { role, ...(value ? { usage: value } : {}) },
    });
    // Pinned Pi records zeros without a provider flag when no usage arrives.
    const unreported = message('assistant', {
      ...usage(0),
      input: 0,
      output: 0,
      cacheRead: 0,
      totalTokens: 0,
    });
    const billed = [
      message('user', usage(1, true)),
      message('assistant', usage(0.001, true)),
      message('toolResult'),
      message('toolResult', usage(0.0002, true)),
      { type: 'usage', usage: usage(0.0003, true) },
      { type: 'compaction', usage: usage(0.0004, true) },
      { type: 'compaction' },
      { type: 'branch_summary', usage: usage(0.0005, true) },
      unreported,
    ];

    expect(runUsage(billed)).toEqual({
      tokens: 750,
      cost: expect.closeTo(0.0024, 10),
    });
    expect(runUsage([...billed, message('assistant', usage(0.001))])).toEqual({
      tokens: 900,
    });
    expect(
      runUsage([...billed, message('assistant', usage(0.001, false))]),
    ).toEqual({ tokens: 900 });
    expect(runUsage([message('assistant', usage(Number.NaN, true))])).toEqual({
      tokens: 150,
    });
    expect(runUsage([unreported])).toBeUndefined();
    expect(runUsage([])).toBeUndefined();
    for (const bad of [{ input: Number.NaN }, { output: -1 }, { input: '5' }])
      expect(
        runUsage([message('assistant', { ...usage(0.001, true), ...bad })]),
      ).toBeUndefined();
  });

  it('reports a refused file only when no write_artifact call succeeded', () => {
    const toolResult = (
      toolName: string,
      isError: boolean,
      text: string,
      details = {},
    ) => ({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName,
        content: [{ type: 'text', text }],
        details,
        isError,
      },
    });
    // Pinned Pi records a schema-rejected call and a throwing execute alike.
    const rejected = toolResult(
      'write_artifact',
      true,
      'Validation failed for tool "write_artifact":\n  - format: expected one of "csv", "md"',
    );
    const thrown = toolResult(
      'write_artifact',
      true,
      'Provide one supported non-empty UTF-8 file up to 32 bytes',
    );
    const details = { sha256: 'a'.repeat(64), format: 'csv' };
    const saved = toolResult('write_artifact', false, 'Saved.', details);

    for (const records of [[rejected], [thrown], [rejected, thrown]])
      expect(artifactOutcome(records, 'write_artifact')).toEqual({
        artifactRefused: true,
      });
    expect(artifactOutcome([rejected, saved], 'write_artifact')).toEqual({
      artifact: details,
    });
    expect(
      artifactOutcome(
        [toolResult('read_input', true, 'Unknown source ID')],
        'write_artifact',
      ),
    ).toEqual({});
    expect(artifactOutcome([], 'write_artifact')).toEqual({});
  });

  it('reports working once on the first live Pi output without exposing it', async () => {
    const reportWorking = vi.fn<() => void>();
    const outcome = await consumeTurn(
      controlledTurn([
        { type: 'status', text: 'session metadata' },
        { type: 'text_delta', text: 'private model output', stream: 'thought' },
        {
          type: 'tool_call',
          text: 'private tool title',
          rawInput: { secret: 'private tool input' },
        },
      ]),
      reportWorking,
    );

    expect(outcome).toEqual({ status: 'completed' });
    expect(reportWorking).toHaveBeenCalledTimes(1);
    expect(reportWorking).toHaveBeenCalledWith();
  });

  it('does not claim working when the turn fails before live output', async () => {
    const reportWorking = vi.fn<() => void>();
    await consumeTurn(
      controlledTurn([{ type: 'error', message: 'provider unavailable' }]),
      reportWorking,
    );

    expect(reportWorking).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: 'error' as const,
      message: 'private provider response',
      detailCode: 'RATE_LIMITED',
    },
    {
      type: 'error' as const,
      message: 'Provider returned HTTP status 402: private billing detail',
    },
  ])(
    'classifies a bounded quota error event without returning its text',
    async (event) => {
      await expect(
        consumeTurn(controlledTurn([event]), vi.fn()),
      ).rejects.toMatchObject({ failureCategory: 'provider_quota' });
    },
  );

  it('classifies the canonical failed turn result by its bounded detail code', async () => {
    await expect(
      consumeTurn(
        controlledTurn([], {
          status: 'failed',
          error: {
            message: 'private provider response',
            detailCode: 'PROVIDER_QUOTA',
          },
        }),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ failureCategory: 'provider_quota' });
  });

  it('recognizes the pinned Pi session errorMessage without broad text matching', () => {
    expect(
      isProviderQuotaSignal(
        '402: {"message":"quota exceeded for synthetic account"}',
      ),
    ).toBe(true);
    expect(
      isProviderQuotaSignal(
        'Provider returned an error: quota exceeded for this account',
      ),
    ).toBe(true);
    expect(
      isProviderQuotaSignal('Provider is temporarily unavailable; retry later'),
    ).toBe(false);
    expect(
      isProviderQuotaSignal(
        '401: ordinary provider failure; invoice 402 is only a reference',
      ),
    ).toBe(false);
    expect(isProviderQuotaSignal('quota'.repeat(1_025))).toBe(false);
  });

  it('classifies only quota and full-Drive failures', () => {
    expect(
      workerFailureCategory(
        Object.assign(new Error('Synthetic full Drive'), { code: 'ENOSPC' }),
      ),
    ).toBe('drive_full');
    expect(
      workerFailureCategory(
        Object.assign(new Error('Synthetic quota text is not authoritative'), {
          code: 'EIO',
        }),
      ),
    ).toBeUndefined();
  });

  it('delivers a failed note-save result when its manifest cannot be written', () => {
    const result = {
      type: 'completed',
      text: 'Saved to this channel’s shared notes.',
    };
    const full = Object.assign(new Error('Synthetic full Drive'), {
      code: 'ENOSPC',
    });

    expect(
      recoverDriveWriteFailure(
        { memory: 'save', session: { seedRunId: 'retained' } },
        result,
        full,
      ),
    ).toMatchObject({
      type: 'failed',
      failureCategory: 'drive_full',
    });
    expect(result.text).not.toContain('Saved');
    const recovered = recoverDriveWriteFailure(
      {},
      {
        type: 'completed',
        text: 'Answer',
        artifactRefused: true,
        usage: { tokens: 150 },
      },
      full,
    );
    expect(recovered).not.toHaveProperty('artifactRefused');
    expect(recovered).not.toHaveProperty('usage');
    expect(() =>
      recoverDriveWriteFailure(
        { session: { seedRunId: 'retained' } },
        { type: 'completed', text: 'Completed answer' },
        full,
      ),
    ).toThrow('Worker state requires inspection');
  });

  it('recognizes quota only in the current durable Pi turn', () => {
    const prior = {
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '402: {"message":"old quota error"}',
      },
    };
    const currentUser = { type: 'message', message: { role: 'user' } };
    const quota = {
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '429: {"message":"quota exceeded"}',
      },
    };
    const generic = {
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '401: ordinary provider failure',
      },
    };

    expect(durableProviderQuota([prior, currentUser, quota], 1)).toBe(true);
    expect(durableProviderQuota([prior, currentUser, generic], 1)).toBe(false);
    expect(durableProviderQuota([prior], 1)).toBe(false);
  });

  it('reports working once when a tool call is the first live event', async () => {
    const reportWorking = vi.fn<() => void>();
    await consumeTurn(
      controlledTurn([
        {
          type: 'tool_call',
          text: 'private tool title',
          rawInput: { secret: 'private tool input' },
        },
        { type: 'text_delta', text: 'private model output' },
      ]),
      reportWorking,
    );

    expect(reportWorking).toHaveBeenCalledTimes(1);
    expect(reportWorking).toHaveBeenCalledWith();
  });
});
