import { LIMITS, type Conversation, type CreateConversationInput } from '@chat/shared';
import { Types } from 'mongoose';
import { badRequest, isDuplicateKeyError, notFound } from '../../lib/http-error';
import { memberUserId, toConversation, type PopulatedConversation } from '../../lib/serializers';
import { Conversation as ConversationModel } from '../../models/conversation.model';
import { Message } from '../../models/message.model';
import { USER_PUBLIC_FIELDS, User } from '../../models/user.model';
import { VERIFIED } from '../users/users.service';

const populateMembers = { path: 'members.user', select: USER_PUBLIC_FIELDS };
const notFoundError = () => notFound('Conversation not found');

/** Filter that matches a conversation only if `userId` is a member. */
const memberFilter = (conversationId: string, userId: string) => ({
  _id: conversationId,
  'members.user': userId,
});

async function countUnread(conversation: PopulatedConversation, userId: string): Promise<number> {
  const me = conversation.members.find((member) => memberUserId(member.user) === userId);
  const filter: Record<string, unknown> = {
    conversation: conversation._id,
    sender: { $ne: new Types.ObjectId(userId) },
  };
  if (me?.lastReadAt) filter.createdAt = { $gt: me.lastReadAt };
  // Stop counting at the cap; the UI shows "99+".
  return Message.countDocuments(filter, { limit: LIMITS.UNREAD_CAP });
}

async function findPopulated(filter: Record<string, unknown>) {
  const doc = await ConversationModel.findOne(filter).populate(populateMembers).lean();
  return doc as unknown as PopulatedConversation | null;
}

/** Ids of every conversation the user is in (used to join socket rooms). */
export async function listConversationIdsForUser(userId: string): Promise<string[]> {
  const docs = await ConversationModel.find({ 'members.user': userId }, { _id: 1 }).lean();
  return docs.map((doc) => doc._id.toString());
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const docs = (await ConversationModel.find({ 'members.user': userId })
    .sort({ lastMessageAt: -1 })
    .limit(200)
    .populate(populateMembers)
    .lean()) as unknown as PopulatedConversation[];

  const unreadCounts = await Promise.all(docs.map((doc) => countUnread(doc, userId)));
  return docs.map((doc, i) => toConversation(doc, unreadCounts[i]));
}

export async function getConversation(conversationId: string, userId: string): Promise<Conversation> {
  // Not a member → 404, not 403, so ids of other people's chats are not confirmed.
  const doc = await findPopulated(memberFilter(conversationId, userId));
  if (!doc) throw notFoundError();
  return toConversation(doc, await countUnread(doc, userId));
}

export async function assertMember(conversationId: string, userId: string): Promise<void> {
  const exists = await ConversationModel.exists(memberFilter(conversationId, userId));
  if (!exists) throw notFoundError();
}

export async function createConversation(
  userId: string,
  input: CreateConversationInput,
): Promise<{ conversation: Conversation; created: boolean }> {
  if (input.type === 'direct') return createDirect(userId, input.userId);
  return createGroup(userId, input.name, input.memberIds);
}

async function createDirect(userId: string, otherUserId: string) {
  if (otherUserId === userId) throw badRequest('You cannot start a chat with yourself');
  if (!(await User.exists({ _id: otherUserId, ...VERIFIED }))) throw notFound('User not found');

  const directKey = [userId, otherUserId].sort().join(':');
  const existing = await ConversationModel.exists({ directKey });
  if (existing) {
    return { conversation: await getConversation(existing._id.toString(), userId), created: false };
  }

  try {
    const doc = await ConversationModel.create({
      type: 'direct',
      directKey,
      createdBy: userId,
      members: [{ user: userId }, { user: otherUserId }],
    });
    return { conversation: await getConversation(doc._id.toString(), userId), created: true };
  } catch (err) {
    // The other person created the same chat a moment earlier: return theirs.
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await ConversationModel.exists({ directKey });
    if (!raced) throw err;
    return { conversation: await getConversation(raced._id.toString(), userId), created: false };
  }
}

async function createGroup(userId: string, name: string, memberIds: string[]) {
  const others = [...new Set(memberIds)].filter((id) => id !== userId);
  if (others.length < 2) throw badRequest('Pick at least 2 other people for a group');

  const found = await User.countDocuments({ _id: { $in: others }, ...VERIFIED });
  if (found !== others.length) throw badRequest('Some of the selected users were not found');

  const doc = await ConversationModel.create({
    type: 'group',
    name,
    createdBy: userId,
    members: [{ user: userId, role: 'owner' }, ...others.map((id) => ({ user: id, role: 'member' as const }))],
  });
  return { conversation: await getConversation(doc._id.toString(), userId), created: true };
}

/** Mark everything in the conversation as read for this user. */
export async function markRead(conversationId: string, userId: string): Promise<Date> {
  const now = new Date();
  const result = await ConversationModel.updateOne(memberFilter(conversationId, userId), {
    // "$" = the members array element that matched 'members.user' in the filter.
    $set: { 'members.$.lastReadAt': now },
  });
  if (result.matchedCount === 0) throw notFoundError();
  return now;
}
