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
  for (const [index, entry] of toolApis.entries()) {
    const { host, header, key, ...extra } = entry;
    if (
      URL.parse('https://' + host)?.hostname !== host ||
      !host.includes('.') ||
      host.endsWith('.') ||
      host.includes('*') ||
      isIP(host) ||
      Object.hasOwn(allow, host) ||
      Object.keys(extra).length ||
      (key === undefined
        ? header !== undefined
        : !/^[\w!#$%&'*+.^`|~-]+$/.test(header ?? '') ||
          !/^[A-Z_][A-Z0-9_]*$/.test(key))
    )
      // Only the position: a field may hold a key pasted by mistake.
      throw new SetupError('Invalid toolApis entry at index ' + index + '.');
    allow[host] =
      key === undefined
        ? []
        : [{ transform: [{ headers: { [header]: read(key) } }] }];
  }
  return allow;
}
