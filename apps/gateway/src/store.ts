import type { WorkerResult } from '@slack-agent-starter/contracts';
import type { RedisStateAdapter } from '@chat-adapter/state-redis';

export type RunRecord = {
  runId: string;
  conversationId: string;
  generation: 1;
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  senderId: string;
  text: string;
  deadline: number;
  callbackHash: string;
  kind: 'work' | 'busy';
  state:
    | 'accepted'
    | 'publishing'
    | 'completed'
    | 'publication_uncertain'
    | 'dispatch_failed';
  result?: WorkerResult;
  messageId?: string;
};

export interface RunStore {
  admit(candidate: RunRecord): Promise<{
    outcome: 'accepted' | 'busy' | 'duplicate';
    run: RunRecord;
  }>;
  getRun(runId: string): Promise<RunRecord | null>;
  claimPublication(
    runId: string,
    result: WorkerResult,
    now: number,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired'>;
  completePublication(runId: string, messageId: string): Promise<boolean>;
  failPublication(runId: string): Promise<boolean>;
  failDispatch(runId: string): Promise<boolean>;
}

const ADMIT_SCRIPT = `
local delivered = redis.call('GET', KEYS[1])
if delivered then
  return {'duplicate', redis.call('GET', ARGV[1] .. delivered)}
end

local logical = redis.call('GET', KEYS[2])
if logical then
  redis.call('SET', KEYS[1], logical)
  return {'duplicate', redis.call('GET', ARGV[1] .. logical)}
end

local candidate = cjson.decode(ARGV[2])
local owner = redis.call('GET', KEYS[3])
local outcome = 'accepted'
if owner then
  candidate.kind = 'busy'
  outcome = 'busy'
end

local run = cjson.encode(candidate)
redis.call('SET', ARGV[1] .. candidate.runId, run)
redis.call('SET', KEYS[1], candidate.runId)
redis.call('SET', KEYS[2], candidate.runId)
if not owner then
  redis.call('SET', KEYS[3], candidate.runId)
end
return {outcome, run}
`;

const CLAIM_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 'conflict' end
local run = cjson.decode(encoded)
local result = cjson.decode(ARGV[2])
if run.runId ~= ARGV[1] or run.runId ~= result.runId or run.generation ~= result.generation then
  return 'conflict'
end
if run.deadline <= tonumber(ARGV[3]) then return 'expired' end
if run.state == 'publishing' or run.state == 'completed' or run.state == 'publication_uncertain' then
  if run.result and run.result.eventId == result.eventId and run.result.runId == result.runId and run.result.generation == result.generation and run.result.sequence == result.sequence and run.result.type == result.type and run.result.text == result.text then
    return 'duplicate'
  end
  return 'conflict'
end
if run.state ~= 'accepted' and run.state ~= 'dispatch_failed' then return 'conflict' end
run.result = result
run.state = 'publishing'
redis.call('SET', KEYS[1], cjson.encode(run))
return 'claimed'
`;

const COMPLETE_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.state ~= 'publishing' then return 0 end
run.state = 'completed'
run.messageId = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(run))
if redis.call('GET', KEYS[2]) == run.runId then redis.call('DEL', KEYS[2]) end
return 1
`;

const FAIL_PUBLICATION_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.state ~= 'publishing' then return 0 end
run.state = 'publication_uncertain'
redis.call('SET', KEYS[1], cjson.encode(run))
return 1
`;

const FAIL_DISPATCH_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.state ~= 'accepted' then return 0 end
run.state = 'dispatch_failed'
redis.call('SET', KEYS[1], cjson.encode(run))
return 1
`;

export class RedisRunStore implements RunStore {
  constructor(
    private readonly state: RedisStateAdapter,
    private readonly namespace = 'slack-agent:m1',
  ) {}

  private runKey(runId: string): string {
    return `${this.namespace}:run:${runId}`;
  }

  private deliveryKey(workspaceId: string, eventId: string): string {
    return `${this.namespace}:event:${workspaceId}:${eventId}`;
  }

  private logicalKey(
    workspaceId: string,
    channelId: string,
    messageTs: string,
  ): string {
    return `${this.namespace}:message:${workspaceId}:${channelId}:${messageTs}`;
  }

  private ownerKey(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): string {
    return `${this.namespace}:owner:${workspaceId}:${channelId}:${threadTs}`;
  }

  async admit(candidate: RunRecord): Promise<{
    outcome: 'accepted' | 'busy' | 'duplicate';
    run: RunRecord;
  }> {
    const outcome = await this.state.getClient().eval(ADMIT_SCRIPT, {
      keys: [
        this.deliveryKey(candidate.workspaceId, candidate.eventId),
        this.logicalKey(
          candidate.workspaceId,
          candidate.channelId,
          candidate.messageTs,
        ),
        this.ownerKey(
          candidate.workspaceId,
          candidate.channelId,
          candidate.threadTs,
        ),
      ],
      arguments: [`${this.namespace}:run:`, JSON.stringify(candidate)],
    });
    if (!Array.isArray(outcome) || outcome.length !== 2) {
      throw new Error('Redis admission returned an invalid result');
    }

    const status = outcome[0];
    const encoded = outcome[1];
    if (
      (status !== 'accepted' && status !== 'busy' && status !== 'duplicate') ||
      typeof encoded !== 'string'
    ) {
      throw new Error('Redis admission returned an invalid result');
    }
    return { outcome: status, run: JSON.parse(encoded) as RunRecord };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const encoded = await this.state.getClient().get(this.runKey(runId));
    return encoded === null ? null : (JSON.parse(encoded) as RunRecord);
  }

  async claimPublication(
    runId: string,
    result: WorkerResult,
    now: number,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired'> {
    return (await this.state.getClient().eval(CLAIM_SCRIPT, {
      keys: [this.runKey(runId)],
      arguments: [runId, JSON.stringify(result), String(now)],
    })) as 'claimed' | 'duplicate' | 'conflict' | 'expired';
  }

  async completePublication(
    runId: string,
    messageId: string,
  ): Promise<boolean> {
    const run = await this.getRun(runId);
    if (run === null) return false;
    return (
      Number(
        await this.state.getClient().eval(COMPLETE_SCRIPT, {
          keys: [
            this.runKey(runId),
            this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
          ],
          arguments: [messageId],
        }),
      ) === 1
    );
  }

  async failPublication(runId: string): Promise<boolean> {
    return (
      Number(
        await this.state.getClient().eval(FAIL_PUBLICATION_SCRIPT, {
          keys: [this.runKey(runId)],
          arguments: [],
        }),
      ) === 1
    );
  }

  async failDispatch(runId: string): Promise<boolean> {
    return (
      Number(
        await this.state.getClient().eval(FAIL_DISPATCH_SCRIPT, {
          keys: [this.runKey(runId)],
          arguments: [],
        }),
      ) === 1
    );
  }
}
