import type { Server as HttpServer } from 'node:http';
import { ERROR_CODES } from '@chat/shared';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { verifyAccessToken } from '../lib/tokens';
import { listConversationIdsForUser } from '../modules/conversations/conversations.service';
import { updateLastSeen } from '../modules/users/users.service';
import { conversationRoom, setIO, userRoom, type ChatServer, type ChatSocket } from '../realtime/io';
import { presence } from '../realtime/presence';
import { registerChatHandlers, type SocketContext } from './handlers';

/** DB writes started by disconnects (lastSeenAt), so shutdown can wait for them. */
const pendingWrites = new Set<Promise<unknown>>();

function track(promise: Promise<unknown>) {
  pendingWrites.add(promise);
  void promise.finally(() => pendingWrites.delete(promise));
}

/** Call after io.close() and before closing the database. */
export async function flushPendingWrites(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

export function createSocketServer(httpServer: HttpServer): ChatServer {
  const io: ChatServer = new Server(httpServer, {
    cors: { origin: env.CLIENT_ORIGINS, credentials: true },
    // Largest payload a client may send (a 4,000-char message is far below this).
    maxHttpBufferSize: 100_000,
  });

  /*
   * Handshake auth. The client connects with io(url, { auth: { token } }).
   * A bad or expired token rejects the connection with "UNAUTHORIZED"; the
   * client then refreshes its access token and connects again.
   */
  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) return next(new Error(ERROR_CODES.UNAUTHORIZED));
    try {
      const claims = await verifyAccessToken(token);
      socket.data.userId = claims.userId;
      socket.data.name = claims.name;
      next();
    } catch {
      next(new Error(ERROR_CODES.UNAUTHORIZED));
    }
  });

  io.on('connection', (socket) => {
    onConnection(io, socket).catch((err: unknown) => {
      logger.error({ err, socketId: socket.id }, 'Socket setup failed');
      socket.disconnect(true);
    });
  });

  setIO(io);
  return io;
}

async function onConnection(io: ChatServer, socket: ChatSocket): Promise<void> {
  const { userId } = socket.data;
  const ctx: SocketContext = {
    typingIn: new Set(),
    log: logger.child({ socketId: socket.id, userId }),
  };

  // Handlers first, so events sent right after connecting are not dropped.
  registerChatHandlers(socket, ctx);
  socket.join(userRoom(userId));

  const conversationIds = await listConversationIdsForUser(userId);
  if (socket.disconnected) return; // closed while we were loading
  socket.join(conversationIds.map(conversationRoom));

  const cameOnline = presence.add(userId, socket.id);
  socket.emit('presence:snapshot', { onlineUserIds: presence.onlineUserIds() });
  if (cameOnline) {
    socket.broadcast.emit('presence:update', { userId, online: true, lastSeenAt: null });
  }
  ctx.log.debug({ rooms: conversationIds.length }, 'Socket connected');

  socket.on('disconnect', (reason) => {
    ctx.log.debug({ reason }, 'Socket disconnected');
    if (!presence.remove(userId, socket.id)) return; // other tabs still open

    const lastSeenAt = new Date();
    io.emit('presence:update', { userId, online: false, lastSeenAt: lastSeenAt.toISOString() });
    track(updateLastSeen(userId, lastSeenAt).catch((err: unknown) => ctx.log.error({ err }, 'Could not save lastSeenAt')));
  });
}
