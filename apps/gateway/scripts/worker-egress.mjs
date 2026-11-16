import { isIP } from 'node:net';

export class SetupError extends Error {}

// The worker firewall's allow map: the gateway host, openrouter.ai with the
// model key, and each tool API host with its optional header. `read` returns
// the value of a SETUP_ENV variable.
export function workerAllow(gatewayHost, modelKey, toolApis, read) {
  const allow = {
    [gatewayHost]: [],
    'openrouter.ai': [
      { transform: [{ headers: { Authorization: 'Bearer ' + modelKey } }] },
    ],
  };
  for (const entry of toolApis) {
    const { host, header, key, ...extra } = entry;
    if (
      URL.parse('https://' + host)?.hostname !== host ||
      !host.includes('.') ||
      host.includes('*') ||
      isIP(host) ||
      Object.hasOwn(allow, host) ||
      Object.keys(extra).length ||
      (key === undefined
        ? header !== undefined
        : !/^[\w!#$%&'*+.^`|~-]+$/.test(header ?? '') ||
          !/^[A-Z_][A-Z0-9_]*$/.test(key))
    )
      throw new SetupError('Invalid toolApis entry: ' + JSON.stringify(entry));
    allow[host] =
      key === undefined
        ? []
        : [{ transform: [{ headers: { [header]: read(key) } }] }];
  }
  return allow;
}
