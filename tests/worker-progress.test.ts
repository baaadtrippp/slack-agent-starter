import { describe, expect, it, vi } from 'vitest';

// The Sandbox entry point is plain JavaScript because it is copied directly
// into the worker image.
// @ts-expect-error No declaration file is shipped for the Sandbox entry point.
import { consumeTurn } from '../apps/worker/sandbox/run.mjs';

type TurnEvent =
  | { type: 'status'; text: string }
  | { type: 'text_delta'; text: string; stream?: 'output' | 'thought' }
  | { type: 'tool_call'; text: string; rawInput?: unknown }
  | { type: 'error'; message: string };

function controlledTurn(events: TurnEvent[]) {
  return {
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    result: Promise.resolve({ status: 'completed' as const }),
  };
}

describe('Sandbox worker progress', () => {
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
});
