import type { Conversation, Message, PublicUser } from '@chat/shared';
import type { Types } from 'mongoose';
import type { ConversationDoc, ConversationMemberDoc } from '../models/conversation.model';
import type { MessageDoc } from '../models/message.model';
import type { UserDoc } from '../models/user.model';

/*
 * Turn database documents into the JSON shapes in @chat/shared.
 * Every response goes through here, so a field like passwordHash can never leak.
 */

type PublicUserDoc = Pick<UserDoc, '_id' | 'name' | 'email' | 'avatarColor' | 'lastSeenAt' | 'createdAt'>;

export type PopulatedMember = Omit<ConversationMemberDoc, 'user'> & { user: PublicUserDoc | null };
export type PopulatedConversation = Omit<ConversationDoc, 'members'> & { members: PopulatedMember[] };

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

export function toPublicUser(user: PublicUserDoc): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    avatarColor: user.avatarColor,
    lastSeenAt: iso(user.lastSeenAt),
    createdAt: user.createdAt.toISOString(),
  };
}

export function toMessage(message: Pick<MessageDoc, '_id' | 'conversation' | 'sender' | 'body' | 'type' | 'clientId' | 'createdAt' | 'editedAt'>): Message {
  return {
    id: message._id.toString(),
    conversationId: message.conversation.toString(),
    senderId: message.sender.toString(),
    body: message.body,
    type: message.type,
    clientId: message.clientId ?? null,
    createdAt: message.createdAt.toISOString(),
    editedAt: iso(message.editedAt),
  };
}

export function toConversation(conversation: PopulatedConversation, unreadCount = 0): Conversation {
  return {
    id: conversation._id.toString(),
    type: conversation.type,
    name: conversation.name ?? null,
    members: conversation.members
      // A deleted user populates as null; leave them out.
      .filter((member): member is PopulatedMember & { user: PublicUserDoc } => member.user !== null)
      .map((member) => ({
        user: toPublicUser(member.user),
        role: member.role,
        lastReadAt: iso(member.lastReadAt),
        joinedAt: member.joinedAt.toISOString(),
      })),
    lastMessage: conversation.lastMessage
      ? {
          id: conversation.lastMessage.messageId.toString(),
          body: conversation.lastMessage.body,
          senderId: conversation.lastMessage.sender.toString(),
          createdAt: conversation.lastMessage.createdAt.toISOString(),
        }
      : null,
    unreadCount,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

/** Id of a member's user, whether it is populated or still an ObjectId. */
export function memberUserId(user: PublicUserDoc | Types.ObjectId | null): string | null {
  // Mongoose gives ObjectId an `_id` getter that returns itself, so this works for both.
  return user ? user._id.toString() : null;
}
