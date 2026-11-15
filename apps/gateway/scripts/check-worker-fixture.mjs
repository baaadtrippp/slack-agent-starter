import assert from 'node:assert/strict';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';

// Stand-in OpenRouter model and gateway callback for check-worker.mjs. It runs
// as root inside the worker Sandbox and listens only on loopback.
const [configPath, statePath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const tls = { cert: readFileSync('cert.pem'), key: readFileSync('key.pem') };
const state = { callbacks: [], models: [], errors: [] };
let listening = 0;
let release;
const stopClosed = new Promise((resolve) => (release = resolve));

function save() {
  writeFileSync(statePath + '.tmp', JSON.stringify(state));
  renameSync(statePath + '.tmp', statePath);
}

async function json(request) {
  return JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
}

function serve(port, handler) {
  createServer(tls, (request, response) =>
    handler(request, response).catch((error) => {
      state.errors.push(String(error?.message ?? error));
      save();
      response.writeHead(500).end();
    }),
  ).listen(port, '127.0.0.1', () => ++listening === 2 && save());
}

serve(8443, async (request, response) => {
  const url = new URL(request.url, 'https://127.0.0.1');
  assert.equal(url.pathname, '/api/worker/callback');
  const body = request.method === 'POST' ? await json(request) : undefined;
  const runId = body?.runId ?? url.searchParams.get('runId');
  assert.ok(
    request.headers.authorization === 'Bearer ' + config.tokens[runId],
    'Unauthorized callback',
  );
  if (body) state.callbacks.push({ runId, type: body.type });
  save();
  response.writeHead(204).end();
});

function chunk(delta, reason) {
  const choices = [{ index: 0, delta, finish_reason: reason }];
  const event = {
    id: 'stand-in',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stand-in',
    choices,
  };
  return 'data: ' + JSON.stringify(event) + '\n\n';
}

function toolCall(name, args, id = name) {
  const call = { name, arguments: JSON.stringify(args) };
  const delta = {
    tool_calls: [{ index: 0, id, type: 'function', function: call }],
  };
  return chunk(delta, 'tool_calls');
}

// The refused run writes over the schema's maxLength, then within maxLength
// but over the byte limit; Pi must return both calls as errors.
function refuse(tools, results) {
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ['write_artifact'],
  );
  const errors = ['Validation failed', 'Provide one supported'];
  results.forEach((result, index) =>
    assert.ok(
      JSON.stringify(result).includes(errors[index]),
      'Pi did not refuse write ' + index,
    ),
  );
  const content = [
    'x'.repeat(config.fileLimit + 1),
    'é'.repeat(Math.floor(config.fileLimit / 2) + 1),
  ][results.length];
  if (!content) return chunk({ content: 'Refused done.' }, 'stop');
  const args = { format: 'txt', content };
  return toolCall('write_artifact', args, 'refused-' + results.length);
}

// Scripted turns: the first run answers at once; the resumed reply reads the
// retained CSV, saves the artifact, then answers. The stopped run's request
// stays open until Stop closes it, and the reply waits for that, so both runs
// are active when the check stops one. In both the new and the resumed session,
// Pi must send one system or developer message holding the instructions file.
// A replayed prompt followed by a section update would be a second message.
async function respond({ messages, tools = [] }, response) {
  const latest = JSON.stringify(messages.findLast((m) => m.role === 'user'));
  const runId = [
    config.first,
    config.reply,
    config.stopped,
    config.refused,
  ].find((id) => latest.includes(id));
  assert.ok(runId, 'Unknown model request');
  state.models.push(runId);
  save();
  if (runId === config.stopped) return void response.once('close', release);
  const system = messages.filter((m) =>
    ['system', 'developer'].includes(m.role),
  );
  assert.ok(
    system.length === 1 &&
      JSON.stringify(system).includes(
        JSON.stringify(config.instructions).slice(1, -1),
      ),
    'Expected one system prompt with the instructions file',
  );
  const results = messages.filter((m) => m.role === 'tool');
  if (runId === config.refused) return refuse(tools, results);
  if (runId === config.reply) await stopClosed;
  const names = tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ['read_input', 'write_artifact']);
  if (runId === config.first)
    return chunk({ content: 'First turn done.' }, 'stop');
  assert.ok(JSON.stringify(messages).includes(config.first), 'Lost turn one');
  if (!results.length) return toolCall('read_input', { source: 'input-1' });
  assert.ok(JSON.stringify(results[0]).includes(config.csvMarker));
  if (results.length === 1)
    return toolCall('write_artifact', {
      format: 'csv',
      content: config.artifact,
    });
  return chunk({ content: 'Reply done.' }, 'stop');
}

serve(443, async (request, response) => {
  if (request.url !== '/api/v1/chat/completions')
    return void response.writeHead(404).end();
  const body = await respond(await json(request), response);
  if (!body) return;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(body + 'data: [DONE]\n\n');
});
