import { createClient } from 'redis';
import { RedisRunStore } from '../src/store.ts';

let client;
try {
  const url = new URL(process.env.REDIS_URL);
  if (!['redis:', 'rediss:'].includes(url.protocol) || url.hash)
    throw new Error('Invalid Redis URL');
  client = createClient({
    url: url.toString(),
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  client.on('error', () => {});
  const indexed = await new RedisRunStore(client).backfillPublishedAnswers();
  console.log('Existing final answers indexed: ' + indexed);
} catch {
  console.error('Could not finish indexing the existing final answers.');
  process.exitCode = 1;
} finally {
  if (client?.isOpen) client.destroy();
}
