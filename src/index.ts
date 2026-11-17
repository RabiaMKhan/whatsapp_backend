import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './db/connect';
import { logger } from './lib/logger';
import { createServer } from './server';
import { flushPendingWrites } from './socket';

await connectDatabase();

const { httpServer, io } = createServer();

httpServer.listen(env.PORT, () => {
  logger.info(`API + Socket.io listening on http://localhost:${env.PORT}`);
});

let shuttingDown = false;

/** Stop taking new connections, close sockets and the DB, then exit. */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // If something hangs, exit anyway after 10 seconds.
  setTimeout(() => process.exit(1), 10_000).unref();

  await io.close(); // disconnects every socket and closes the HTTP server
  await flushPendingWrites(); // let "last seen" saves from those disconnects finish
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
