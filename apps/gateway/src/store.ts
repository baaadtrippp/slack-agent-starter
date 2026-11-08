import type {
  WorkerJob,
  WorkerProgress,
  WorkerResult,
  WorkerSession,
} from '../../../packages/contracts/src/index.js';
import type { RedisClientType } from 'redis';
import { randomUUID } from 'node:crypto';

export type SandboxTarget = {
  sandboxName: string;
  sessionId: string;
};

export type RunControlRef = {
  runId: string;
  generation: number;
  statusMessageId: string;
};

export type AnswerRef = {
  workspaceId: string;
  channelId: string;
  messageId: string;
};

export type FeedbackReaction = 'thumbsup' | 'thumbsdown';

export type FeedbackState = {
  active: boolean;
  eventTs: string;
};

export type ManagedRuntime =
  | {
      phase: 'ready';
      sessionId: string;
      driveId: string;
    }
  | {
      phase: 'starting';
      sessionId: string;
      driveId: string;
      operationId: string;
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
    | 'interrupted'
    | 'stopping'
    | 'stopped';
  controls?: true;
  memory?: WorkerJob['memory'];
  session?: WorkerSession;
  result?: WorkerResult;
  execution?: SandboxTarget;
  recovery?: SandboxTarget;
  exitConfirmed?: true;
  blockedBy?: string;
  messageId?: string;
  progress?: WorkerProgress;
  statusClaimed?: boolean;
  statusClaimToken?: string;
  statusMessageId?: string;
  statusVersion?: number;
  artifactPublication?: 'uploaded' | 'failed';
  feedback?: Record<string, Partial<Record<FeedbackReaction, FeedbackState>>>;
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
  isThreadAvailable(run: RunRecord): Promise<boolean>;
  claimProgress(
    progress: WorkerProgress,
    now: number,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired'>;
  claimStatusCreation(runId: string): Promise<boolean>;
  recordStatusMessage(runId: string, messageId: string): Promise<boolean>;
  claimStatusEdit(runId: string, token: string): Promise<boolean>;
  finishStatusEdit(
    runId: string,
    token: string,
    version?: number,
  ): Promise<'done' | 'changed' | 'lost'>;
  reserveArtifactCollection(runId: string, lease: string): Promise<boolean>;
  claimPublication(
    runId: string,
    result: WorkerResult,
    now: number,
    artifactLease?: string,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired' | 'retry'>;
  claimSavedResult(
    observed: RunRecord,
    result: WorkerResult,
  ): Promise<'claimed' | 'duplicate' | 'conflict'>;
  claimUnsubmitted(run: RunRecord, result: WorkerResult): Promise<boolean>;
  completePublication(run: RunRecord, messageId: string): Promise<boolean>;
  recordArtifactPublication(
    runId: string,
    outcome: 'uploaded' | 'failed',
  ): Promise<boolean>;
  failPublication(runId: string): Promise<boolean>;
  failDispatch(runId: string): Promise<boolean>;
  requestStop(
    reference: RunControlRef,
  ): Promise<'requested' | 'duplicate' | 'terminal' | 'conflict'>;
  confirmStopped(
    observed: RunRecord,
    completedSession?: WorkerSession,
  ): Promise<'confirmed' | 'duplicate' | 'conflict'>;
  getPublishedAnswer(reference: AnswerRef): Promise<RunRecord | null>;
  openAnswerPublication(workspaceId: string, channelId: string): Promise<void>;
  hasOpenAnswerPublication(
    workspaceId: string,
    channelId: string,
  ): Promise<boolean>;
  recordFeedback(
    reference: AnswerRef,
    reactorId: string,
    reaction: FeedbackReaction,
    action: 'added' | 'removed',
    eventTs: string,
    allowPending?: boolean,
  ): Promise<'recorded' | 'duplicate' | 'stale' | 'conflict'>;
  recordDispatchTarget(
    job: WorkerJob,
    target: SandboxTarget,
    managed?: boolean,
  ): Promise<'recorded' | 'conflict' | 'stopping' | 'unavailable'>;
  interruptRun(
    run: RunRecord,
    now: number,
    sessionRestored?: boolean,
  ): Promise<boolean>;
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
local observed = ARGV[5] and cjson.decode(ARGV[5])
if ARGV[3] == 'unsubmitted' then
  if run.kind ~= 'work' or run.execution or result.type ~= 'failed' or result.session or
     redis.call('GET', KEYS[2]) ~= run.runId then return 'conflict' end
elseif observed then
  if run.kind ~= 'work' or run.eventId ~= observed.eventId or
     run.workspaceId ~= observed.workspaceId or run.channelId ~= observed.channelId or
     run.threadTs ~= observed.threadTs or not run.execution or not observed.execution or
     run.execution.sandboxName ~= observed.execution.sandboxName or
     run.execution.sessionId ~= observed.execution.sessionId then return 'conflict' end
elseif run.deadline <= tonumber(ARGV[3]) then return 'expired' end
local function sameSession(a, b)
  if not a or not b then return not a and not b end
  return a.seedRunId == b.seedRunId and a.nativeId == b.nativeId and a.adapterId == b.adapterId and a.revision == b.revision and a.hasRetainedSources == b.hasRetainedSources
end
local function sameArtifact(a, b)
  if not a or not b then return not a and not b end
  return a.sha256 == b.sha256 and a.format == b.format
end
if run.state == 'publishing' or run.state == 'completed' or run.state == 'worker_failed' or run.state == 'publication_uncertain' then
  if run.result and run.result.eventId == result.eventId and run.result.runId == result.runId and run.result.generation == result.generation and run.result.sequence == result.sequence and run.result.type == result.type and run.result.text == result.text and sameArtifact(run.result.artifact, result.artifact) and sameSession(run.result.session, result.session) then
    return 'duplicate'
  end
  return 'conflict'
end
if run.state ~= 'accepted' and run.state ~= 'dispatch_failed' then return 'conflict' end
if observed and redis.call('GET', KEYS[3]) ~= run.runId then return 'conflict' end
if ARGV[4] and ARGV[4] ~= '' and redis.call('GET', KEYS[2]) ~= ARGV[4] then return 'retry' end
if observed then run.exitConfirmed = true end
run.result = result
run.state = 'publishing'
run.statusVersion = (run.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(run))
return 'claimed'
`;

const COMPLETE_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.state ~= 'publishing' then return 0 end
local indexable = run.kind == 'work' and run.memory ~= 'save' and run.result.type == 'completed'
local answerOwner = indexable and redis.call('GET', KEYS[4])
if answerOwner and answerOwner ~= run.runId then return 0 end
local owns = redis.call('GET', KEYS[2]) == run.runId
if run.result.session and not owns then return 0 end
run.state = run.result.type == 'failed' and 'worker_failed' or 'completed'
run.messageId = ARGV[1]
run.statusVersion = (run.statusVersion or 0) + 1
if indexable then
  local pending = redis.call('GET', KEYS[5])
  if pending then run.feedback = cjson.decode(pending) end
  redis.call('SET', KEYS[4], run.runId)
  redis.call('DEL', KEYS[5])
end
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

const REQUEST_STOP_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 'conflict' end
local run = cjson.decode(encoded)
if run.runId ~= ARGV[1] or run.generation ~= tonumber(ARGV[2]) or
   not run.statusMessageId or run.statusMessageId ~= ARGV[3] or
   run.kind ~= 'work' or not run.controls or run.memory == 'save' then return 'conflict' end
if run.state == 'stopping' or run.state == 'stopped' then return 'duplicate' end
if run.state == 'publishing' or run.state == 'completed' or
   run.state == 'worker_failed' or run.state == 'publication_uncertain' or
   run.state == 'interrupted' then return 'terminal' end
if run.state ~= 'accepted' and run.state ~= 'dispatch_failed' then return 'conflict' end
if redis.call('GET', KEYS[2]) ~= run.runId then return 'conflict' end
run.state = 'stopping'
run.statusVersion = (run.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(run))
return 'requested'
`;

const CONFIRM_STOPPED_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 'conflict' end
local run = cjson.decode(encoded)
local observed = cjson.decode(ARGV[1])
local function sameTarget(a, b)
  if not a or not b then return not a and not b end
  return a.sandboxName == b.sandboxName and a.sessionId == b.sessionId
end
if run.runId ~= observed.runId or run.eventId ~= observed.eventId or
   run.generation ~= observed.generation or run.workspaceId ~= observed.workspaceId or
   run.channelId ~= observed.channelId or run.threadTs ~= observed.threadTs or
   run.conversationId ~= observed.conversationId or
   not sameTarget(run.execution, observed.execution) then return 'conflict' end
local owner = redis.call('GET', KEYS[2])
if run.state == 'stopped' then return owner and 'conflict' or 'duplicate' end
if run.state ~= 'stopping' or owner ~= run.runId then return 'conflict' end
if ARGV[2] ~= '' then
  local next = cjson.decode(ARGV[2])
  local saved = redis.call('GET', KEYS[4])
  local previous = saved and cjson.decode(saved)
  local ref = previous and previous.reference
  local input = run.session
  if not ref or not input or ref.seedRunId ~= input.seedRunId or
     ref.nativeId ~= input.nativeId or ref.adapterId ~= input.adapterId or
     ref.revision ~= input.revision or ref.hasRetainedSources ~= input.hasRetainedSources or
     next.seedRunId ~= input.seedRunId or next.nativeId ~= input.nativeId or
     next.adapterId ~= input.adapterId or next.revision <= input.revision or
     (input.hasRetainedSources and not next.hasRetainedSources) then return 'conflict' end
  previous.reference = next
  redis.call('SET', KEYS[4], cjson.encode(previous))
end
run.state = 'stopped'
run.statusVersion = (run.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(run))
redis.call('DEL', KEYS[2])
if run.execution then redis.call('SREM', KEYS[3], run.runId) end
if run.recovery then
  redis.call('SREM', ARGV[3] .. run.recovery.sandboxName .. ':' .. run.recovery.sessionId .. ':active', run.runId)
end
return 'confirmed'
`;

const BACKFILL_ANSWER_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.kind ~= 'work' or run.memory == 'save' or run.state ~= 'completed' or
   not run.result or run.result.type ~= 'completed' or
   run.workspaceId ~= ARGV[1] or run.channelId ~= ARGV[2] or
   run.messageId ~= ARGV[3] or run.runId ~= ARGV[4] then return 0 end
return redis.call('SET', KEYS[2], run.runId, 'NX') and 1 or 0
`;

const RECORD_FEEDBACK_SCRIPT = `
local answerRunId = redis.call('GET', KEYS[1])
local run
local feedback
local pendingTtl
if answerRunId then
  local encoded = redis.call('GET', ARGV[1] .. answerRunId)
  if not encoded then return 'conflict' end
  run = cjson.decode(encoded)
  if run.runId ~= answerRunId or run.state ~= 'completed' or
     run.kind ~= 'work' or not run.result or run.result.type ~= 'completed' or
     run.workspaceId ~= ARGV[2] or run.channelId ~= ARGV[3] or
     run.messageId ~= ARGV[4] then return 'conflict' end
  feedback = run.feedback or {}
else
  if ARGV[9] ~= '1' then return 'conflict' end
  pendingTtl = redis.call('PTTL', KEYS[2])
  if pendingTtl < 1 then return 'conflict' end
  local pending = redis.call('GET', KEYS[3])
  feedback = pending and cjson.decode(pending) or {}
end
local reactor = feedback[ARGV[5]] or {}
local previous = reactor[ARGV[6]]
local active = ARGV[7] == 'added'
if previous then
  if previous.eventTs > ARGV[8] then return 'stale' end
  if previous.eventTs == ARGV[8] then
    return previous.active == active and 'duplicate' or 'conflict'
  end
end
reactor[ARGV[6]] = {active = active, eventTs = ARGV[8]}
feedback[ARGV[5]] = reactor
if run then
  run.feedback = feedback
  redis.call('SET', ARGV[1] .. answerRunId, cjson.encode(run))
else
  redis.call('SET', KEYS[3], cjson.encode(feedback), 'PX', pendingTtl)
end
return 'recorded'
`;

const FAIL_PUBLICATION_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.state ~= 'publishing' then return 0 end
run.state = 'publication_uncertain'
run.statusVersion = (run.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(run))
return 1
`;

const FAIL_DISPATCH_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.state ~= 'accepted' then return 0 end
run.state = 'dispatch_failed'
run.statusVersion = (run.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(run))
return 1
`;

const RECORD_DISPATCH_TARGET_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 'conflict' end
local run = cjson.decode(encoded)
if run.runId ~= ARGV[1] or run.generation ~= tonumber(ARGV[2]) then return 'conflict' end
if run.state == 'stopping' or run.state == 'stopped' then return 'stopping' end
if run.kind ~= 'work' or run.state ~= 'accepted' or run.execution then return 'conflict' end
if redis.call('GET', KEYS[2]) ~= run.runId then return 'conflict' end
local gate = redis.call('GET', KEYS[3])
if gate and gate ~= 'open' then return 'stopping' end
local target = cjson.decode(ARGV[3])
if ARGV[4] == '1' then
  if not gate then return 'unavailable' end
  local managedEncoded = redis.call('GET', KEYS[5])
  if not managedEncoded then return 'unavailable' end
  local managed = cjson.decode(managedEncoded)
  if managed.phase ~= 'ready' or managed.sessionId ~= target.sessionId then
    return 'unavailable'
  end
end
run.execution = target
redis.call('SET', KEYS[1], cjson.encode(run))
redis.call('SADD', KEYS[4], run.runId)
return 'recorded'
`;

const COMPARE_MANAGED_RUNTIME_SCRIPT = `
local currentEncoded = redis.call('GET', KEYS[1])
local current = currentEncoded and cjson.decode(currentEncoded)
local previous = ARGV[1] ~= '' and cjson.decode(ARGV[1])
local next = cjson.decode(ARGV[2])
local function same(a, b)
  if not a or not b then return not a and not b end
  if a.phase ~= b.phase or a.sessionId ~= b.sessionId or a.driveId ~= b.driveId then
    return false
  end
  if a.phase == 'starting' then return a.operationId == b.operationId end
  return true
end
if same(current, next) then return 1 end
if not same(current, previous) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

const RELEASE_DISPATCH_TARGET_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
local target = cjson.decode(ARGV[2])
if run.runId ~= ARGV[1] or not run.execution or
   run.execution.sandboxName ~= target.sandboxName or
   run.execution.sessionId ~= target.sessionId then return 0 end
local recovery = run.recovery
if ARGV[3] == 'unsubmitted' and
   (run.state == 'accepted' or run.state == 'stopping') then
  run.execution = nil
  run.recovery = nil
  redis.call('SET', KEYS[1], cjson.encode(run), 'KEEPTTL')
end
redis.call('SREM', KEYS[2], run.runId)
if recovery then
  redis.call('SREM', ARGV[4] .. recovery.sandboxName .. ':' .. recovery.sessionId .. ':active', run.runId)
end
return 1
`;

const RELEASE_RECOVERY_TARGET_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return '' end
local run = cjson.decode(encoded)
local observed = cjson.decode(ARGV[1])
if run.runId ~= observed.runId or run.eventId ~= observed.eventId or
   run.generation ~= observed.generation or not run.execution or
   not observed.execution or
   run.execution.sandboxName ~= observed.execution.sandboxName or
   run.execution.sessionId ~= observed.execution.sessionId then return '' end
if run.state ~= 'completed' and run.state ~= 'worker_failed' and
   run.state ~= 'publication_uncertain' and run.state ~= 'stopped' and
   run.state ~= 'interrupted' then return '' end
local target = run.recovery
if not target then
  if run.exitConfirmed ~= true then return '' end
  target = run.execution
end
redis.call('SREM', KEYS[2], run.runId)
if run.recovery then
  redis.call('SREM', ARGV[2] .. run.recovery.sandboxName .. ':' .. run.recovery.sessionId .. ':active', run.runId)
end
return cjson.encode(target)
`;

const FENCE_LOST_TARGET_SCRIPT = `
local gate = redis.call('GET', KEYS[1])
if gate == 'open' then
  redis.call('SET', KEYS[1], cjson.encode({state = 'lost'}))
  return 1
end
if not gate then return 0 end
local closed = cjson.decode(gate)
return closed.state == 'lost' and 1 or 0
`;

const BIND_RECOVERY_TARGET_SCRIPT = `
local gate = redis.call('GET', KEYS[1])
if not gate or gate == 'open' or cjson.decode(gate).state ~= 'lost' then return 0 end
if redis.call('GET', KEYS[3]) ~= 'open' then return 0 end
local old = cjson.decode(ARGV[1])
local replacement = cjson.decode(ARGV[2])
local ids = redis.call('SMEMBERS', KEYS[2])
for _, id in ipairs(ids) do
  local key = ARGV[3] .. id
  local encoded = redis.call('GET', key)
  if not encoded then
    redis.call('SREM', KEYS[2], id)
  else
    local run = cjson.decode(encoded)
    local current = run.recovery or run.execution
    local original = run.execution and
      run.execution.sandboxName == old.sandboxName and
      run.execution.sessionId == old.sessionId
    local replay = original and run.recovery and
      run.recovery.sandboxName == replacement.sandboxName and
      run.recovery.sessionId == replacement.sessionId
    if not current then
      redis.call('SREM', KEYS[2], id)
    elseif (current.sandboxName ~= old.sandboxName or
            current.sessionId ~= old.sessionId) and not replay then
      if not original then redis.call('SREM', KEYS[2], id) end
    elseif run.state == 'accepted' or run.state == 'dispatch_failed' or
           run.state == 'stopping' then
      if not replay then
        local migrated = run.recovery ~= nil
        run.recovery = replacement
        redis.call('SET', key, cjson.encode(run), 'KEEPTTL')
        if migrated then redis.call('SREM', KEYS[2], id) end
      end
      redis.call('SADD', KEYS[4], id)
    else
      redis.call('SREM', KEYS[2], id)
      if run.recovery then
        redis.call('SREM', ARGV[4] .. run.recovery.sandboxName .. ':' .. run.recovery.sessionId .. ':active', id)
      end
    end
  end
end
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
if redis.call('SCARD', KEYS[2]) ~= 0 or redis.call('EXISTS', KEYS[3]) ~= 0 then return 'active' end
redis.call('SET', KEYS[1], cjson.encode({state = 'stopping', operationId = ARGV[1]}))
return 'claimed'
`;

const INTERRUPT_RUN_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local current = cjson.decode(encoded)
local old = cjson.decode(ARGV[1])
if current.runId ~= old.runId or current.eventId ~= old.eventId or current.generation ~= old.generation or
   current.workspaceId ~= old.workspaceId or current.channelId ~= old.channelId or
   current.threadTs ~= old.threadTs or current.controls ~= old.controls or
   current.memory ~= old.memory then return 0 end
if current.execution or old.execution then
  if not current.execution or not old.execution or
     current.execution.sandboxName ~= old.execution.sandboxName or
     current.execution.sessionId ~= old.execution.sessionId then return 0 end
elseif not current.controls then
  return 0
end
local owner = redis.call('GET', KEYS[2])
-- A retry reports the thread available only while no newer run owns it.
if current.state == 'interrupted' then return owner and 0 or 1 end
if owner ~= current.runId then return 0 end
if current.kind ~= 'work' or
   (current.state ~= 'accepted' and current.state ~= 'dispatch_failed') or
   (current.session and current.execution and current.memory ~= 'save' and
    (ARGV[3] ~= '1' or not current.controls)) or current.result or
   current.deadline > tonumber(ARGV[2]) then return 0 end
current.state = 'interrupted'
current.statusVersion = (current.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(current))
redis.call('DEL', KEYS[2])
if current.execution then redis.call('SREM', KEYS[3], current.runId) end
if current.recovery then
  redis.call('SREM', ARGV[4] .. current.recovery.sandboxName .. ':' .. current.recovery.sessionId .. ':active', current.runId)
end
return 1
`;

const PROGRESS_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 'conflict' end
local run = cjson.decode(encoded)
local progress = cjson.decode(ARGV[1])
if run.runId ~= progress.runId or run.generation ~= progress.generation or run.kind ~= 'work' then return 'conflict' end
if run.deadline <= tonumber(ARGV[2]) then return 'expired' end
if run.result or (run.state ~= 'accepted' and run.state ~= 'dispatch_failed') or
   not run.execution or redis.call('GET', KEYS[2]) ~= run.runId then return 'conflict' end
if run.progress then
  return run.progress.eventId == progress.eventId and run.progress.sequence == progress.sequence and 'duplicate' or 'conflict'
end
run.progress = progress
run.statusVersion = (run.statusVersion or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(run))
return 'claimed'
`;

const STATUS_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local run = cjson.decode(encoded)
if run.kind ~= 'work' then return 0 end
if ARGV[1] == 'claim' then
  if run.statusClaimed then
    return run.statusClaimToken == ARGV[2] and not run.statusMessageId and 1 or 0
  end
  run.statusClaimed = true
  run.statusClaimToken = ARGV[2]
  run.statusVersion = (run.statusVersion or 0) + 1
else
  if not run.statusClaimed then return 0 end
  if run.statusMessageId then return run.statusMessageId == ARGV[2] and 1 or 0 end
  run.statusMessageId = ARGV[2]
end
redis.call('SET', KEYS[1], cjson.encode(run))
return 1
`;

// A renderer drains changes while it owns the lease. The atomic version check
// prevents a terminal update racing an in-flight Slack edit from being lost.
const FINISH_STATUS_EDIT_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 'lost' end
local encoded = redis.call('GET', KEYS[1])
if ARGV[2] ~= '' and encoded and (cjson.decode(encoded).statusVersion or 0) ~= tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[2], 60000)
  return 'changed'
end
redis.call('DEL', KEYS[2])
return 'done'
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

  private answerKey(reference: AnswerRef): string {
    return `${this.namespace}:answer:${reference.workspaceId}:${reference.channelId}:${reference.messageId}`;
  }

  private answerPublicationKey(workspaceId: string, channelId: string) {
    return `${this.namespace}:answer-publication:${workspaceId}:${channelId}`;
  }

  private pendingFeedbackKey(reference: AnswerRef) {
    return this.answerKey(reference) + ':pending';
  }

  private runPrefix(): string {
    return `${this.namespace}:run:`;
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

  private managedRuntimeKey(sandboxName: string): string {
    return `${this.namespace}:runtime:${sandboxName}:managed`;
  }

  private idleGateKey(target: SandboxTarget): string {
    return `${this.namespace}:idle:${target.sandboxName}:${target.sessionId}:gate`;
  }

  private recoveryKey(target: SandboxTarget) {
    return this.idleGateKey(target) + ':read';
  }

  private activeDispatchKey(target: SandboxTarget): string {
    return `${this.namespace}:idle:${target.sandboxName}:${target.sessionId}:active`;
  }

  private activeDispatchPrefix(): string {
    return `${this.namespace}:idle:`;
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

  private csvCollectionKey(runId: string) {
    return `${this.runKey(runId)}:csv-collection`;
  }

  async claimProgress(progress: WorkerProgress, now: number) {
    const run = await this.getRun(progress.runId);
    if (!run) return 'conflict' as const;
    return (await this.execute((client) =>
      client.eval(PROGRESS_SCRIPT, {
        keys: [
          this.runKey(run.runId),
          this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
        ],
        arguments: [JSON.stringify(progress), String(now)],
      }),
    )) as 'claimed' | 'duplicate' | 'conflict' | 'expired';
  }

  async claimStatusCreation(runId: string): Promise<boolean> {
    const token = randomUUID();
    const claim = () =>
      this.execute((client) =>
        client.eval(STATUS_SCRIPT, {
          keys: [this.runKey(runId)],
          arguments: ['claim', token],
        }),
      );
    return Number(await claim().catch(claim)) === 1;
  }

  async recordStatusMessage(
    runId: string,
    messageId: string,
  ): Promise<boolean> {
    const record = () =>
      this.execute((client) =>
        client.eval(STATUS_SCRIPT, {
          keys: [this.runKey(runId)],
          arguments: ['record', messageId],
        }),
      );
    return Number(await record().catch(record)) === 1;
  }

  private statusEditKey(runId: string) {
    return `${this.runKey(runId)}:status-edit`;
  }

  async claimStatusEdit(runId: string, token: string): Promise<boolean> {
    const claim = () =>
      this.execute((client) =>
        client.eval(
          `
      local current = redis.call('GET', KEYS[1])
      if current and current ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', 60000)
      return 1
    `,
          { keys: [this.statusEditKey(runId)], arguments: [token] },
        ),
      );
    return Number(await claim().catch(claim)) === 1;
  }

  async finishStatusEdit(runId: string, token: string, version?: number) {
    const finish = () =>
      this.execute((client) =>
        client.eval(FINISH_STATUS_EDIT_SCRIPT, {
          keys: [this.runKey(runId), this.statusEditKey(runId)],
          arguments: [token, version === undefined ? '' : String(version)],
        }),
      );
    return (await finish().catch(finish)) as 'done' | 'changed' | 'lost';
  }

  async reserveArtifactCollection(
    runId: string,
    lease: string,
  ): Promise<boolean> {
    return (
      (await this.execute((client) =>
        client.set(this.csvCollectionKey(runId), lease, {
          NX: true,
          PX: 7_000,
        }),
      )) === 'OK'
    );
  }

  async claimPublication(
    runId: string,
    result: WorkerResult,
    now: number,
    artifactLease?: string,
  ): Promise<'claimed' | 'duplicate' | 'conflict' | 'expired' | 'retry'> {
    return (await this.execute((client) =>
      client.eval(CLAIM_SCRIPT, {
        keys: [this.runKey(runId), this.csvCollectionKey(runId)],
        arguments: [
          runId,
          JSON.stringify(result),
          String(now),
          ...(artifactLease ? [artifactLease] : []),
        ],
      }),
    )) as 'claimed' | 'duplicate' | 'conflict' | 'expired' | 'retry';
  }

  async claimSavedResult(
    observed: RunRecord,
    result: WorkerResult,
  ): Promise<'claimed' | 'duplicate' | 'conflict'> {
    return (await this.execute((client) =>
      client.eval(CLAIM_SCRIPT, {
        keys: [
          this.runKey(observed.runId),
          this.csvCollectionKey(observed.runId),
          this.ownerKey(
            observed.workspaceId,
            observed.channelId,
            observed.threadTs,
          ),
        ],
        arguments: [
          observed.runId,
          JSON.stringify(result),
          'saved',
          '',
          JSON.stringify(observed),
        ],
      }),
    )) as 'claimed' | 'duplicate' | 'conflict';
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
    const answer = {
      workspaceId: run.workspaceId,
      channelId: run.channelId,
      messageId,
    };
    return (
      Number(
        await this.execute((client) =>
          client.eval(COMPLETE_SCRIPT, {
            keys: [
              this.runKey(run.runId),
              this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
              this.sessionKey(run.conversationId),
              this.answerKey(answer),
              this.pendingFeedbackKey(answer),
            ],
            arguments: [messageId],
          }),
        ),
      ) === 1
    );
  }

  async recordArtifactPublication(
    runId: string,
    outcome: 'uploaded' | 'failed',
  ): Promise<boolean> {
    const record = () =>
      this.execute((client) =>
        client.eval(
          `
      local encoded = redis.call('GET', KEYS[1])
      if not encoded then return 0 end
      local run = cjson.decode(encoded)
      if run.state ~= 'completed' or not run.result or not run.result.artifact then return 0 end
      if run.artifactPublication then return run.artifactPublication == ARGV[1] and 1 or 0 end
      run.artifactPublication = ARGV[1]
      run.statusVersion = (run.statusVersion or 0) + 1
      redis.call('SET', KEYS[1], cjson.encode(run))
      return 1
    `,
          { keys: [this.runKey(runId)], arguments: [outcome] },
        ),
      );
    return Number(await record().catch(record)) === 1;
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

  async requestStop(
    reference: RunControlRef,
  ): Promise<'requested' | 'duplicate' | 'terminal' | 'conflict'> {
    const run = await this.getRun(reference.runId);
    if (!run) return 'conflict';
    return (await this.execute((client) =>
      client.eval(REQUEST_STOP_SCRIPT, {
        keys: [
          this.runKey(run.runId),
          this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
        ],
        arguments: [
          reference.runId,
          String(reference.generation),
          reference.statusMessageId,
        ],
      }),
    )) as 'requested' | 'duplicate' | 'terminal' | 'conflict';
  }

  async confirmStopped(
    observed: RunRecord,
    completedSession?: WorkerSession,
  ): Promise<'confirmed' | 'duplicate' | 'conflict'> {
    const inactiveKey = `${this.runKey(observed.runId)}:no-execution`;
    return (await this.execute((client) =>
      client.eval(CONFIRM_STOPPED_SCRIPT, {
        keys: [
          this.runKey(observed.runId),
          this.ownerKey(
            observed.workspaceId,
            observed.channelId,
            observed.threadTs,
          ),
          observed.execution
            ? this.activeDispatchKey(observed.execution)
            : inactiveKey,
          this.sessionKey(observed.conversationId),
        ],
        arguments: [
          JSON.stringify(observed),
          completedSession ? JSON.stringify(completedSession) : '',
          this.activeDispatchPrefix(),
        ],
      }),
    )) as 'confirmed' | 'duplicate' | 'conflict';
  }

  /** Rebuilds reverse lookup entries from exact, confirmed final publications. */
  async backfillPublishedAnswers() {
    let count = 0;
    let cursor = '0';
    const prefix = this.runPrefix();
    do {
      const page = await this.execute((client) =>
        client.scan(cursor, { MATCH: prefix + '*', COUNT: 100 }),
      );
      cursor = page.cursor;
      for (const key of page.keys) {
        const id = key.slice(prefix.length);
        if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
        const run = await this.getRun(id);
        if (
          run?.kind !== 'work' ||
          run.state !== 'completed' ||
          run.result?.type !== 'completed' ||
          !/^\d{10}\.\d{6}$/.test(run.messageId ?? '') ||
          run.runId !== id ||
          !run.messageId
        )
          continue;
        count += Number(
          await this.execute((client) =>
            client.eval(BACKFILL_ANSWER_SCRIPT, {
              keys: [
                key,
                this.answerKey({
                  workspaceId: run.workspaceId,
                  channelId: run.channelId,
                  messageId: run.messageId!,
                }),
              ],
              arguments: [run.workspaceId, run.channelId, run.messageId!, id],
            }),
          ),
        );
      }
    } while (cursor !== '0');
    return count;
  }

  async getPublishedAnswer(reference: AnswerRef): Promise<RunRecord | null> {
    const runId = await this.execute((client) =>
      client.get(this.answerKey(reference)),
    );
    if (runId === null) return null;
    if (typeof runId !== 'string')
      throw new Error('Redis answer lookup returned an invalid result');
    const run = await this.getRun(runId);
    if (
      !run ||
      run.kind !== 'work' ||
      run.state !== 'completed' ||
      run.result?.type !== 'completed' ||
      run.workspaceId !== reference.workspaceId ||
      run.channelId !== reference.channelId ||
      run.messageId !== reference.messageId
    )
      return null;
    return run;
  }

  async openAnswerPublication(workspaceId: string, channelId: string) {
    await this.execute((client) =>
      client.set(this.answerPublicationKey(workspaceId, channelId), '1', {
        EX: 30,
      }),
    );
  }

  async hasOpenAnswerPublication(workspaceId: string, channelId: string) {
    return (
      (await this.execute((client) =>
        client.exists(this.answerPublicationKey(workspaceId, channelId)),
      )) === 1
    );
  }

  async recordFeedback(
    reference: AnswerRef,
    reactorId: string,
    reaction: FeedbackReaction,
    action: 'added' | 'removed',
    eventTs: string,
    allowPending = false,
  ): Promise<'recorded' | 'duplicate' | 'stale' | 'conflict'> {
    return (await this.execute((client) =>
      client.eval(RECORD_FEEDBACK_SCRIPT, {
        keys: [
          this.answerKey(reference),
          this.answerPublicationKey(reference.workspaceId, reference.channelId),
          this.pendingFeedbackKey(reference),
        ],
        arguments: [
          this.runPrefix(),
          reference.workspaceId,
          reference.channelId,
          reference.messageId,
          reactorId,
          reaction,
          action,
          eventTs,
          allowPending ? '1' : '0',
        ],
      }),
    )) as 'recorded' | 'duplicate' | 'stale' | 'conflict';
  }

  async recordDispatchTarget(
    job: WorkerJob,
    target: SandboxTarget,
    managed = false,
  ): Promise<'recorded' | 'conflict' | 'stopping' | 'unavailable'> {
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
          this.managedRuntimeKey(target.sandboxName),
        ],
        arguments: [
          job.runId,
          String(job.generation),
          JSON.stringify(target),
          managed ? '1' : '0',
        ],
      }),
    )) as 'recorded' | 'conflict' | 'stopping' | 'unavailable';
  }

  async getManagedRuntime(sandboxName: string): Promise<ManagedRuntime | null> {
    const encoded = await this.execute((client) =>
      client.get(this.managedRuntimeKey(sandboxName)),
    );
    if (encoded === null) return null;
    if (typeof encoded !== 'string')
      throw new Error(
        'Redis managed runtime lookup returned an invalid result',
      );
    return JSON.parse(encoded) as ManagedRuntime;
  }

  async compareManagedRuntime(
    sandboxName: string,
    previous: ManagedRuntime | null,
    next: ManagedRuntime,
  ): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(COMPARE_MANAGED_RUNTIME_SCRIPT, {
            keys: [this.managedRuntimeKey(sandboxName)],
            arguments: [
              previous ? JSON.stringify(previous) : '',
              JSON.stringify(next),
            ],
          }),
        ),
      ) === 1
    );
  }

  async isIdleSessionOpen(target: SandboxTarget): Promise<boolean> {
    return (
      (await this.execute((client) => client.get(this.idleGateKey(target)))) ===
      'open'
    );
  }

  async releaseDispatchTarget(
    runId: string,
    target: SandboxTarget,
    unsubmitted = false,
  ): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(RELEASE_DISPATCH_TARGET_SCRIPT, {
            keys: [this.runKey(runId), this.activeDispatchKey(target)],
            arguments: [
              runId,
              JSON.stringify(target),
              unsubmitted ? 'unsubmitted' : '',
              this.activeDispatchPrefix(),
            ],
          }),
        ),
      ) === 1
    );
  }

  async releaseRecoveryTarget(
    run: RunRecord,
  ): Promise<SandboxTarget | undefined> {
    if (!run.execution) return;
    const encoded = await this.execute((client) =>
      client.eval(RELEASE_RECOVERY_TARGET_SCRIPT, {
        keys: [this.runKey(run.runId), this.activeDispatchKey(run.execution!)],
        arguments: [JSON.stringify(run), this.activeDispatchPrefix()],
      }),
    );
    if (typeof encoded !== 'string' || !encoded) return;
    return JSON.parse(encoded) as SandboxTarget;
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

  async fenceLostTarget(target: SandboxTarget): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(FENCE_LOST_TARGET_SCRIPT, {
            keys: [this.idleGateKey(target)],
            arguments: [],
          }),
        ),
      ) === 1
    );
  }

  async isLostTarget(target: SandboxTarget): Promise<boolean> {
    const gate = await this.execute((client) =>
      client.get(this.idleGateKey(target)),
    );
    if (typeof gate !== 'string' || gate === 'open') return false;
    try {
      return (JSON.parse(gate) as { state?: string }).state === 'lost';
    } catch {
      return false;
    }
  }

  async bindRecoveryTarget(
    target: SandboxTarget,
    replacement: SandboxTarget,
  ): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(BIND_RECOVERY_TARGET_SCRIPT, {
            keys: [
              this.idleGateKey(target),
              this.activeDispatchKey(target),
              this.idleGateKey(replacement),
              this.activeDispatchKey(replacement),
            ],
            arguments: [
              JSON.stringify(target),
              JSON.stringify(replacement),
              this.runPrefix(),
              this.activeDispatchPrefix(),
            ],
          }),
        ),
      ) === 1
    );
  }

  async reserveRecovery(target: SandboxTarget, token: string) {
    return (
      Number(
        await this.execute((client) =>
          client.eval(
            `
        if redis.call('GET', KEYS[1]) ~= 'open' then return 0 end
        return redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', 30000) and 1 or 0
      `,
            {
              keys: [this.idleGateKey(target), this.recoveryKey(target)],
              arguments: [token],
            },
          ),
        ),
      ) === 1
    );
  }

  async finishRecovery(target: SandboxTarget, token: string) {
    await this.execute((client) =>
      client.eval(
        `
        if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
        return 1
      `,
        { keys: [this.recoveryKey(target)], arguments: [token] },
      ),
    );
  }

  async isThreadAvailable(run: RunRecord) {
    return (
      (await this.execute((client) =>
        client.get(this.ownerKey(run.workspaceId, run.channelId, run.threadTs)),
      )) === null
    );
  }

  async claimIdleStop(
    target: SandboxTarget,
    operationId: string,
  ): Promise<'claimed' | 'active' | 'unenrolled' | 'stopping'> {
    return (await this.execute((client) =>
      client.eval(CLAIM_IDLE_STOP_SCRIPT, {
        keys: [
          this.idleGateKey(target),
          this.activeDispatchKey(target),
          this.recoveryKey(target),
        ],
        arguments: [operationId],
      }),
    )) as 'claimed' | 'active' | 'unenrolled' | 'stopping';
  }

  async interruptRun(
    run: RunRecord,
    now: number,
    sessionRestored = false,
  ): Promise<boolean> {
    return (
      Number(
        await this.execute((client) =>
          client.eval(INTERRUPT_RUN_SCRIPT, {
            keys: [
              this.runKey(run.runId),
              this.ownerKey(run.workspaceId, run.channelId, run.threadTs),
              run.execution
                ? this.activeDispatchKey(run.execution)
                : `${this.runKey(run.runId)}:no-execution`,
            ],
            arguments: [
              JSON.stringify(run),
              String(now),
              sessionRestored ? '1' : '0',
              this.activeDispatchPrefix(),
            ],
          }),
        ),
      ) === 1
    );
  }
}
