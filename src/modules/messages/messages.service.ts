import type { ListMessagesQuery, Message, MessagesResponse, SendMessageInput } from '@chat/shared';
import { Types } from 'mongoose';
import { isDuplicateKeyError } from '../../lib/http-error';
import { toMessage } from '../../lib/serializers';
import { Conversation } from '../../models/conversation.model';
import { Message as MessageModel } from '../../models/message.model';
import { assertMember } from '../conversations/conversations.service';

const PREVIEW_LENGTH = 200;

/** One page of messages, oldest first. Use `nextCursor` as `before` for the page above. */
export async function listMessages(
  conversationId: string,
  userId: string,
  { before, limit }: ListMessagesQuery,
): Promise<MessagesResponse> {
  await assertMember(conversationId, userId);

  const filter: Record<string, unknown> = { conversation: conversationId };
  if (before) filter._id = { $lt: new Types.ObjectId(before) };

  // Fetch one extra to know if there is another page.
  const docs = await MessageModel.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = docs.length > limit;
  const page = (hasMore ? docs.slice(0, limit) : docs).reverse();

  return {
    messages: page.map(toMessage),
    nextCursor: hasMore && page[0] ? page[0]._id.toString() : null,
  };
}

/**
 * Save a message. Returns `created: false` when this clientId was already saved
 * (a retry after a dropped connection), so callers do not broadcast it twice.
 */
export async function sendMessage(
  userId: string,
  input: SendMessageInput,
): Promise<{ message: Message; created: boolean }> {
  await assertMember(input.conversationId, userId);

  const findExisting = () => MessageModel.findOne({ sender: userId, clientId: input.clientId }).lean();

  const existing = await findExisting();
  if (existing) return { message: toMessage(existing), created: false };

  let doc;
  try {
    doc = await MessageModel.create({
      conversation: input.conversationId,
      sender: userId,
      body: input.body,
      clientId: input.clientId,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const raced = await findExisting();
      if (raced) return { message: toMessage(raced), created: false };
    }
    throw err;
  }

  // Update the conversation preview, and mark it read for the sender.
  // (No transaction: a standalone MongoDB has none. If this fails, the message
  // is still saved and the preview catches up on the next message.)
  await Conversation.updateOne(
    { _id: input.conversationId, 'members.user': userId },
    {
      $set: {
        lastMessage: {
          messageId: doc._id,
          body: doc.body.slice(0, PREVIEW_LENGTH),
          sender: doc.sender,
          createdAt: doc.createdAt,
        },
        lastMessageAt: doc.createdAt,
        'members.$.lastReadAt': doc.createdAt,
      },
    },
  );

  return { message: toMessage(doc), created: true };
}
