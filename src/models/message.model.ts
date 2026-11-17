import { LIMITS, type MessageType } from '@chat/shared';
import { Schema, model, type Types } from 'mongoose';

export interface MessageDoc {
  _id: Types.ObjectId;
  conversation: Types.ObjectId;
  sender: Types.ObjectId;
  body: string;
  type: MessageType;
  clientId: string | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<MessageDoc>(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: LIMITS.MESSAGE_MAX },
    type: { type: String, enum: ['text', 'system'], default: 'text' },
    clientId: { type: String, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Paging through a conversation, newest first (cursor = message _id).
messageSchema.index({ conversation: 1, _id: -1 });

// Unread counts: "messages in this conversation after my lastReadAt".
messageSchema.index({ conversation: 1, createdAt: 1 });

// Safe retries: the same sender + clientId can only be saved once.
messageSchema.index(
  { sender: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);

export const Message = model<MessageDoc>('Message', messageSchema);
