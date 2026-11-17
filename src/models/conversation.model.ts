import { LIMITS, type ConversationType, type MemberRole } from '@chat/shared';
import { Schema, model, type Types } from 'mongoose';

export interface ConversationMemberDoc {
  user: Types.ObjectId;
  role: MemberRole;
  /** Everything up to this time counts as read for this member. */
  lastReadAt: Date | null;
  joinedAt: Date;
}

/** A copy of the newest message, so the conversation list needs no extra query. */
export interface LastMessageDoc {
  messageId: Types.ObjectId;
  body: string;
  sender: Types.ObjectId;
  createdAt: Date;
}

export interface ConversationDoc {
  _id: Types.ObjectId;
  type: ConversationType;
  name: string | null;
  /** Direct chats only: the two user ids sorted and joined with ":". */
  directKey: string | null;
  members: ConversationMemberDoc[];
  lastMessage: LastMessageDoc | null;
  lastMessageAt: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const memberSchema = new Schema<ConversationMemberDoc>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'member'], default: 'member' },
    lastReadAt: { type: Date, default: null },
    joinedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const lastMessageSchema = new Schema<LastMessageDoc>(
  {
    messageId: { type: Schema.Types.ObjectId, required: true },
    body: { type: String, required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const conversationSchema = new Schema<ConversationDoc>(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    name: { type: String, trim: true, maxlength: LIMITS.GROUP_NAME_MAX, default: null },
    directKey: { type: String, default: null },
    members: { type: [memberSchema], required: true },
    lastMessage: { type: lastMessageSchema, default: null },
    lastMessageAt: { type: Date, default: () => new Date() },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// "My conversations, newest activity first."
conversationSchema.index({ 'members.user': 1, lastMessageAt: -1 });

// Only one direct chat per pair of users, even if both click "start chat" at once.
conversationSchema.index(
  { directKey: 1 },
  { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } },
);

export const Conversation = model<ConversationDoc>('Conversation', conversationSchema);
