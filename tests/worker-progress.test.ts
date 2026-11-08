import { describe, expect, it, vi } from 'vitest';
import { workerResultSchema } from '../packages/contracts/src/index.js';

// The Sandbox entry point is plain JavaScript because it is copied directly
// into the worker image.
// @ts-expect-error No declaration file is shipped for the Sandbox entry point.
import * as sandboxWorker from '../apps/worker/sandbox/run.mjs';

const { consumeTurn, isProviderQuotaSignal, workerFailureCategory } =
  sandboxWorker;

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
