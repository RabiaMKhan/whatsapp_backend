/**
 * Who is online: userId → ids of that user's open sockets (one per tab/device).
 * A user is online while they have at least one socket.
 *
 * This lives in memory, so it works for ONE server process. To run several,
 * add the Socket.io Redis adapter and keep this map in Redis.
 */
const socketsByUser = new Map<string, Set<string>>();

export const presence = {
  /** Returns true if this is the user's first socket (they just came online). */
  add(userId: string, socketId: string): boolean {
    const sockets = socketsByUser.get(userId) ?? new Set<string>();
    const wasOffline = sockets.size === 0;
    sockets.add(socketId);
    socketsByUser.set(userId, sockets);
    return wasOffline;
  },

  /** Returns true if that was the user's last socket (they just went offline). */
  remove(userId: string, socketId: string): boolean {
    const sockets = socketsByUser.get(userId);
    if (!sockets?.delete(socketId)) return false;
    if (sockets.size > 0) return false;
    socketsByUser.delete(userId);
    return true;
  },

  isOnline: (userId: string) => socketsByUser.has(userId),

  onlineUserIds: () => [...socketsByUser.keys()],
};
