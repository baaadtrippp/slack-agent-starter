import type {
  WorkerJob,
  WorkerResult,
  WorkerSession,
} from '../../../packages/contracts/src/index.js';
import type { RedisClientType } from 'redis';

export type SandboxTarget = {
  sandboxName: string;
  sessionId: string;
};

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
  deadline: number;
  callbackHash: string;
  kind: 'work' | 'busy';
  state:
    | 'accepted'
    | 'publishing'
    | 'completed'
    | 'worker_failed'
    | 'publication_uncertain'
    | 'dispatch_failed'
    | 'interrupted';
  session?: WorkerSession;
  result?: WorkerResult;
  execution?: SandboxTarget;
  blockedBy?: string;
  messageId?: string;
};

export interface RunStore {
  admit(
    candidate: RunRecord,
    continuationOnly?: boolean,
  ): Promise<{
    outcome: 'accepted' | 'busy' | 'duplicate' | 'inactive';
    run: RunRecord;
  }>;
  getRun(runId: string): Promise<RunRecord | null>;
  claimPublication(
    runId: string,
    result: WorkerResult,
    now: number,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired'>;
  claimUnsubmitted(run: RunRecord, result: WorkerResult): Promise<boolean>;
  completePublication(run: RunRecord, messageId: string): Promise<boolean>;
  failPublication(runId: string): Promise<boolean>;
  failDispatch(runId: string): Promise<boolean>;
  recordDispatchTarget(
    job: WorkerJob,
    target: SandboxTarget,
  ): Promise<'recorded' | 'conflict' | 'stopping'>;
  interruptRun(run: RunRecord, now: number): Promise<boolean>;
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
local saved = redis.call('GET', KEYS[4])
local session = saved and cjson.decode(saved)
if (session and candidate.messageTs <= session.activeSince) or
   (ARGV[3] == '1' and not session and not owner) then
  return {'inactive', ARGV[2]}
end
if session then candidate.session = session.reference end
local outcome = 'accepted'
if owner then
  candidate.kind = 'busy'
  candidate.blockedBy = owner
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
if ARGV[3] == 'unsubmitted' then
  if run.kind ~= 'work' or run.execution or result.type ~= 'failed' or result.session or
     redis.call('GET', KEYS[2]) ~= run.runId then return 'conflict' end
elseif run.deadline <= tonumber(ARGV[3]) then return 'expired' end
local function sameSession(a, b)
  if not a or not b then return not a and not b end
  return a.seedRunId == b.seedRunId and a.nativeId == b.nativeId and a.adapterId == b.adapterId and a.revision == b.revision
end
if run.state == 'publishing' or run.state == 'completed' or run.state == 'worker_failed' or run.state == 'publication_uncertain' then
  if run.result and run.result.eventId == result.eventId and run.result.runId == result.runId and run.result.generation == result.generation and run.result.sequence == result.sequence and run.result.type == result.type and run.result.text == result.text and sameSession(run.result.session, result.session) then
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
local owns = redis.call('GET', KEYS[2]) == run.runId
if run.result.session and not owns then return 0 end
run.state = run.result.type == 'failed' and 'worker_failed' or 'completed'
run.messageId = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(run))
if owns then
  if run.result.type == 'completed' and run.result.session then
    local saved = redis.call('GET', KEYS[3])
    local activeSince = saved and cjson.decode(saved).activeSince or run.messageId
    redis.call('SET', KEYS[3], cjson.encode({
      reference = run.result.session,
      activeSince = activeSince
    }))
  end
  redis.call('DEL', KEYS[2])
end
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

const RECORD_DISPATCH_TARGET_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 'conflict' end
local run = cjson.decode(encoded)
if run.runId ~= ARGV[1] or run.generation ~= tonumber(ARGV[2]) then return 'conflict' end
if run.kind ~= 'work' or run.state ~= 'accepted' or run.execution then return 'conflict' end
if redis.call('GET', KEYS[2]) ~= run.runId then return 'conflict' end
local gate = redis.call('GET', KEYS[3])
if gate and gate ~= 'open' then return 'stopping' end
run.execution = cjson.decode(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(run))
redis.call('SADD', KEYS[4], run.runId)
return 'recorded'
`;

const RELEASE_DISPATCH_TARGET_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
local target = cjson.decode(ARGV[2])
if run.runId ~= ARGV[1] or not run.execution or
   run.execution.sandboxName ~= target.sandboxName or
   run.execution.sessionId ~= target.sessionId then return 0 end
redis.call('SREM', KEYS[2], run.runId)
return 1
`;

const ENROLL_IDLE_SESSION_SCRIPT = `
local gate = redis.call('GET', KEYS[1])
if gate then return gate == 'open' and 1 or 0 end
if redis.call('SCARD', KEYS[2]) ~= 0 then return 0 end
redis.call('SET', KEYS[1], 'open')
return 1
`;

const CLAIM_IDLE_STOP_SCRIPT = `
local gate = redis.call('GET', KEYS[1])
if not gate then return 'unenrolled' end
if gate ~= 'open' then
  local stopping = cjson.decode(gate)
  return stopping.operationId == ARGV[1] and 'claimed' or 'stopping'
end
if redis.call('SCARD', KEYS[2]) ~= 0 then return 'active' end
redis.call('SET', KEYS[1], cjson.encode({state = 'stopping', operationId = ARGV[1]}))
return 'claimed'
`;

const INTERRUPT_RUN_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local current = cjson.decode(encoded)
local old = cjson.decode(ARGV[1])
if current.runId ~= old.runId or current.eventId ~= old.eventId or current.generation ~= old.generation or
   current.workspaceId ~= old.workspaceId or current.channelId ~= old.channelId or current.threadTs ~= old.threadTs then return 0 end
if not current.execution or not old.execution or
   current.execution.sandboxName ~= old.execution.sandboxName or
   current.execution.sessionId ~= old.execution.sessionId then return 0 end
local owner = redis.call('GET', KEYS[2])
-- A retry reports the thread available only while no newer run owns it.
if current.state == 'interrupted' then return owner and 0 or 1 end
if owner ~= current.runId then return 0 end
if current.kind ~= 'work' or
   (current.state ~= 'accepted' and current.state ~= 'dispatch_failed') or
   current.session or current.result or current.deadline > tonumber(ARGV[2]) then return 0 end
current.state = 'interrupted'
redis.call('SET', KEYS[1], cjson.encode(current))
redis.call('DEL', KEYS[2])
return 1
`;

export class RedisRunStore implements RunStore {
  private connectPromise: Promise<unknown> | undefined;
  private readonly client: RedisClientType;
  private readonly namespace: string;

  constructor(client: RedisClientType, namespace = 'slack-agent:m1') {
    this.client = client;
    this.namespace = namespace;
  }

  private async execute<T>(
    operation: (client: RedisClientType) => Promise<T>,
  ): Promise<T> {
    const client = this.client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (client.isOpen) client.destroy();
        reject(new Error('Redis operation timed out'));
      }, 1_000);
    });
    try {
      return await Promise.race([
        (async () => {
          if (!client.isReady) {
            if (!this.connectPromise) {
              const connection = client.connect().finally(() => {
                if (this.connectPromise === connection)
                  this.connectPromise = undefined;
              });
              this.connectPromise = connection;
            }
            await this.connectPromise;
          }
          return operation(client);
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

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

  private sessionKey(conversationId: string): string {
    return `${this.namespace}:session:${conversationId}`;
  }

  private idleGateKey(target: SandboxTarget): string {
    return `${this.namespace}:idle:${target.sandboxName}:${target.sessionId}:gate`;
  }

  private activeDispatchKey(target: SandboxTarget): string {
    return `${this.namespace}:idle:${target.sandboxName}:${target.sessionId}:active`;
  }

  async admit(
    candidate: RunRecord,
    continuationOnly = false,
  ): Promise<{
    outcome: 'accepted' | 'busy' | 'duplicate' | 'inactive';
    run: RunRecord;
  }> {
    const outcome = await this.execute((client) =>
      client.eval(ADMIT_SCRIPT, {
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
          this.sessionKey(candidate.conversationId),
        ],
        arguments: [
          `${this.namespace}:run:`,
          JSON.stringify(candidate),
          continuationOnly ? '1' : '0',
        ],
      }),
    );
    if (!Array.isArray(outcome) || outcome.length !== 2) {
      throw new Error('Redis admission returned an invalid result');
    }

    const status = outcome[0];
    const encoded = outcome[1];
    if (
      (status !== 'accepted' &&
        status !== 'busy' &&
        status !== 'duplicate' &&
        status !== 'inactive') ||
      typeof encoded !== 'string'
    ) {
      throw new Error('Redis admission returned an invalid result');
    }
    return { outcome: status, run: JSON.parse(encoded) as RunRecord };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const encoded = await this.execute((client) =>
      client.get(this.runKey(runId)),
    );
    if (encoded === null) return null;
    if (typeof encoded !== 'string')
      throw new Error('Redis run lookup returned an invalid result');
    return JSON.parse(encoded) as RunRecord;
  }

  async claimPublication(
    runId: string,
    result: WorkerResult,
    now: number,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired'> {
    return (await this.execute((client) =>
      client.eval(CLAIM_SCRIPT, {
        keys: [this.runKey(runId)],
        arguments: [runId, JSON.stringify(result), String(now)],
      }),
    )) as 'claimed' | 'duplicate' | 'conflict' | 'expired';
  }

  async claimUnsubmitted(
    run: RunRecord,
    result: WorkerResult,
  ): Promise<boolean> {
    return (
      (await this.execute((client) =>
        client.eval(CLAIM_SCRIPT, {
          keys: [
            this.runKey(run.runId),
            this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
          ],
          arguments: [run.runId, JSON.stringify(result), 'unsubmitted'],
        }),
      )) === 'claimed'
    );
  }

  async completePublication(
    run: RunRecord,
    messageId: string,
  ): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(COMPLETE_SCRIPT, {
            keys: [
              this.runKey(run.runId),
              this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
              this.sessionKey(run.conversationId),
            ],
            arguments: [messageId],
          }),
        ),
      ) === 1
    );
  }

  async failPublication(runId: string): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(FAIL_PUBLICATION_SCRIPT, {
            keys: [this.runKey(runId)],
            arguments: [],
          }),
        ),
      ) === 1
    );
  }

  async failDispatch(runId: string): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(FAIL_DISPATCH_SCRIPT, {
            keys: [this.runKey(runId)],
            arguments: [],
          }),
        ),
      ) === 1
    );
  }

  async recordDispatchTarget(
    job: WorkerJob,
    target: SandboxTarget,
  ): Promise<'recorded' | 'conflict' | 'stopping'> {
    return (await this.execute((client) =>
      client.eval(RECORD_DISPATCH_TARGET_SCRIPT, {
        keys: [
          this.runKey(job.runId),
          this.ownerKey(
            job.input.workspaceId,
            job.input.channelId,
            job.input.threadTs,
          ),
          this.idleGateKey(target),
          this.activeDispatchKey(target),
        ],
        arguments: [job.runId, String(job.generation), JSON.stringify(target)],
      }),
    )) as 'recorded' | 'conflict' | 'stopping';
  }

  async releaseDispatchTarget(
    runId: string,
    target: SandboxTarget,
  ): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(RELEASE_DISPATCH_TARGET_SCRIPT, {
            keys: [this.runKey(runId), this.activeDispatchKey(target)],
            arguments: [runId, JSON.stringify(target)],
          }),
        ),
      ) === 1
    );
  }

  async enrollIdleSession(target: SandboxTarget): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(ENROLL_IDLE_SESSION_SCRIPT, {
            keys: [this.idleGateKey(target), this.activeDispatchKey(target)],
            arguments: [],
          }),
        ),
      ) === 1
    );
  }

  async claimIdleStop(
    target: SandboxTarget,
    operationId: string,
  ): Promise<'claimed' | 'active' | 'unenrolled' | 'stopping'> {
    return (await this.execute((client) =>
      client.eval(CLAIM_IDLE_STOP_SCRIPT, {
        keys: [this.idleGateKey(target), this.activeDispatchKey(target)],
        arguments: [operationId],
      }),
    )) as 'claimed' | 'active' | 'unenrolled' | 'stopping';
  }

  async interruptRun(run: RunRecord, now: number): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(INTERRUPT_RUN_SCRIPT, {
            keys: [
              this.runKey(run.runId),
              this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
            ],
            arguments: [JSON.stringify(run), String(now)],
          }),
        ),
      ) === 1
    );
  }
}
