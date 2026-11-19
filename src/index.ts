import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './db/connect';
import { logger } from './lib/logger';
import { createServer } from './server';

await connectDatabase();

const { httpServer } = createServer();

httpServer.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT}`);
  if (!env.ABLY_API_KEY) logger.warn('ABLY_API_KEY is not set: nothing will be pushed live');
});

let shuttingDown = false;

/** Stop taking new requests, close the DB, then exit. */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // If something hangs, exit anyway after 10 seconds.
  setTimeout(() => process.exit(1), 10_000).unref();

  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
