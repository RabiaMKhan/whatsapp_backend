import { createServer as createHttpServer } from 'node:http';
import { createApp } from './app';
import { createSocketServer } from './socket';

/**
 * Express and Socket.io share ONE HTTP server (and port). Socket.io handles
 * requests to /socket.io/*, Express handles everything else.
 */
export function createServer() {
  const app = createApp();
  const httpServer = createHttpServer(app);
  const io = createSocketServer(httpServer);
  return { app, httpServer, io };
}
