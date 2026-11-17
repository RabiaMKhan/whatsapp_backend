import type {
  ClientToServerEvents,
  Conversation,
  InterServerEvents,
  Message,
  ReadReceiptPayload,
  ServerToClientEvents,
  SocketData,
} from '@chat/shared';
import type { Server, Socket } from 'socket.io';

export type ChatServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/*
 * Rooms:
 *   user:<userId>                 every open tab/device of one user
 *   conversation:<conversationId> every member's sockets for one conversation
 */
export const userRoom = (userId: string) => `user:${userId}`;
export const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;

let io: ChatServer | null = null;

export function setIO(server: ChatServer | null): void {
  io = server;
}

/**
 * Broadcasts used by both REST routes and socket handlers, so a message sent
 * either way reaches clients the same way. No-ops if Socket.io is not running.
 */
export const realtime = {
  messageCreated(message: Message) {
    // Whole room, sender included: their other tabs need it too.
    // The sending tab matches it to its optimistic message by clientId.
    io?.to(conversationRoom(message.conversationId)).emit('message:new', message);
  },

  conversationCreated(conversation: Conversation) {
    if (!io) return;
    const memberRooms = conversation.members.map((member) => userRoom(member.user.id));
    // Sockets that are already connected join the new conversation room now.
    io.in(memberRooms).socketsJoin(conversationRoom(conversation.id));
    io.to(memberRooms).emit('conversation:new', conversation);
  },

  conversationRead(payload: ReadReceiptPayload) {
    io?.to(conversationRoom(payload.conversationId)).emit('conversation:read', payload);
  },
};
