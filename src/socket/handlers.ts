import {
  ERROR_CODES,
  conversationRefSchema,
  sendMessageSchema,
  type AckResponse,
} from '@chat/shared';
import type { Logger } from 'pino';
import { HttpError } from '../lib/http-error';
import { markRead } from '../modules/conversations/conversations.service';
import { sendMessage } from '../modules/messages/messages.service';
import { conversationRoom, realtime, type ChatSocket } from '../realtime/io';
import { createRateLimiter } from './rate-limiter';

export interface SocketContext {
  /** Conversations this socket is currently "typing" in. */
  typingIn: Set<string>;
  log: Logger;
}

const fail = (code: string, message: string): AckResponse<never> => ({ ok: false, error: { code, message } });

function toAckError(err: unknown, log: Logger): AckResponse<never> {
  if (err instanceof HttpError) return fail(err.code, err.message);
  log.error({ err }, 'Socket handler failed');
  return fail(ERROR_CODES.INTERNAL_ERROR, 'Something went wrong. Please try again.');
}

/**
 * Socket.io hands us whatever the client sent, so every payload is validated
 * with the same Zod schemas as REST, and every ack is checked to be a function.
 */
export function registerChatHandlers(socket: ChatSocket, ctx: SocketContext): void {
  const { userId } = socket.data;
  const { log } = ctx;

  // Burst of 15 messages, then 3 per second. Typing events get their own bucket.
  const messageLimiter = createRateLimiter({ capacity: 15, refillPerSecond: 3 });
  const typingLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 2 });

  const isInRoom = (conversationId: string) => socket.rooms.has(conversationRoom(conversationId));

  function stopTyping(conversationId: string) {
    if (!ctx.typingIn.delete(conversationId)) return;
    socket.to(conversationRoom(conversationId)).emit('typing:update', { conversationId, userId, isTyping: false });
  }

  socket.on('message:send', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!messageLimiter.take()) {
      return ack(fail(ERROR_CODES.RATE_LIMITED, 'You are sending messages too fast'));
    }

    const parsed = sendMessageSchema.safeParse(payload);
    if (!parsed.success) {
      return ack(fail(ERROR_CODES.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid message'));
    }

    try {
      const { message, created } = await sendMessage(userId, parsed.data);
      if (created) {
        realtime.messageCreated(message);
        stopTyping(message.conversationId);
      }
      ack({ ok: true, data: message });
    } catch (err) {
      ack(toAckError(err, log));
    }
  });

  socket.on('conversation:read', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const parsed = conversationRefSchema.safeParse(payload);
    if (!parsed.success) return respond(fail(ERROR_CODES.VALIDATION_ERROR, 'Invalid conversation id'));

    try {
      const { conversationId } = parsed.data;
      const lastReadAt = (await markRead(conversationId, userId)).toISOString();
      realtime.conversationRead({ conversationId, userId, lastReadAt });
      respond({ ok: true, data: { lastReadAt } });
    } catch (err) {
      respond(toAckError(err, log));
    }
  });

  // Typing is fire-and-forget. Clients send typing:start every few seconds while
  // typing, and treat "typing" as over if nothing arrives for ~5 seconds.
  socket.on('typing:start', (payload) => {
    const parsed = conversationRefSchema.safeParse(payload);
    if (!parsed.success || !isInRoom(parsed.data.conversationId) || !typingLimiter.take()) return;

    const { conversationId } = parsed.data;
    ctx.typingIn.add(conversationId);
    socket.to(conversationRoom(conversationId)).emit('typing:update', { conversationId, userId, isTyping: true });
  });

  socket.on('typing:stop', (payload) => {
    const parsed = conversationRefSchema.safeParse(payload);
    if (parsed.success) stopTyping(parsed.data.conversationId);
  });

  socket.on('disconnecting', () => {
    for (const conversationId of [...ctx.typingIn]) stopTyping(conversationId);
  });
}
