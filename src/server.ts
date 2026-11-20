import { createServer as createHttpServer } from 'node:http';
import { createApp } from './app';

/**
 * A plain HTTP server around the Express app, for local development and
 * tests. Real-time updates go through Ably (see realtime/publisher.ts), so
 * there is no socket server to attach. On Vercel, src/vercel.ts is used
 * instead.
 */
export function createServer() {
  const app = createApp();
  const httpServer = createHttpServer(app);
  return { app, httpServer };
}
