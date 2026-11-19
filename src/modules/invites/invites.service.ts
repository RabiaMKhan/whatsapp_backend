import {
  ERROR_CODES,
  INVITE,
  type Conversation,
  type CreateInviteInput,
  type CreateInviteResponse,
  type Invite as InviteDto,
} from '@chat/shared';
import { env } from '../../config/env';
import { inviteEmail } from '../../lib/email-templates';
import { badRequest, HttpError, unauthorized } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { sendEmail } from '../../lib/mailer';
import { toPublicUser } from '../../lib/serializers';
import { Invite, type InviteDoc } from '../../models/invite.model';
import { USER_PUBLIC_FIELDS, User } from '../../models/user.model';
import { createConversation } from '../conversations/conversations.service';
import { VERIFIED } from '../users/users.service';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const toInvite = (doc: InviteDoc): InviteDto => ({
  id: doc._id.toString(),
  email: doc.email,
  status: doc.acceptedAt ? 'joined' : 'pending',
  lastSentAt: doc.lastSentAt.toISOString(),
  joinedAt: doc.acceptedAt?.toISOString() ?? null,
});

const tooMany = (message: string, retryAfterSeconds?: number) =>
  new HttpError(429, ERROR_CODES.RATE_LIMITED, message, retryAfterSeconds ? { retryAfterSeconds } : undefined);

/** The link in the email: opens sign-up with the email already filled in. */
export const joinUrl = (email: string) => `${env.APP_URL}/register?email=${encodeURIComponent(email)}`;

/**
 * Invite someone by email.
 *  - Already has a verified account → nothing is sent; their profile comes back.
 *  - Invited by you in the last hour → 429, so one person can't be flooded.
 *  - More than INVITE.DAILY_LIMIT invites in 24 hours → 429.
 * The email is sent before anything is saved, so a failed send can be retried.
 */
export async function createInvite(userId: string, input: CreateInviteInput): Promise<CreateInviteResponse> {
  const inviter = await User.findById(userId);
  if (!inviter) throw unauthorized('Account not found');

  if (input.email === inviter.email) throw badRequest("That's your own email address.");

  const member = await User.findOne({ email: input.email, ...VERIFIED }).select(USER_PUBLIC_FIELDS).lean();
  if (member) return { status: 'already_member', user: toPublicUser(member) };

  const now = Date.now();
  const existing = await Invite.findOne({ invitedBy: inviter._id, email: input.email });
  if (existing) {
    const waitMs = existing.lastSentAt.getTime() + INVITE.RESEND_COOLDOWN_MINUTES * MINUTE_MS - now;
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / MINUTE_MS);
      throw tooMany(
        `You already invited ${input.email}. You can send another invite in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        Math.ceil(waitMs / 1000),
      );
    }
  }

  const sentToday = await Invite.countDocuments({ invitedBy: inviter._id, lastSentAt: { $gt: new Date(now - DAY_MS) } });
  if (sentToday >= INVITE.DAILY_LIMIT) {
    throw tooMany(`You can send up to ${INVITE.DAILY_LIMIT} invites a day. Please try again tomorrow.`);
  }

  try {
    await sendEmail(inviteEmail({ to: input.email, inviterName: inviter.name, joinUrl: joinUrl(input.email) }));
  } catch (err) {
    logger.error({ err, userId }, 'Could not send invite email');
    throw new HttpError(503, ERROR_CODES.EMAIL_FAILED, "We couldn't send the invite. Please try again in a moment.");
  }

  const invite = await Invite.findOneAndUpdate(
    { invitedBy: inviter._id, email: input.email },
    // $inc on a new document starts from 0, so a first invite has sendCount 1.
    { $set: { lastSentAt: new Date(now) }, $inc: { sendCount: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!invite) throw new Error('Invite upsert returned nothing');
  return { status: 'sent', invite: toInvite(invite) };
}

/** Invites the user sent, newest first. */
export async function listInvites(userId: string): Promise<InviteDto[]> {
  const docs = await Invite.find({ invitedBy: userId }).sort({ lastSentAt: -1 }).limit(INVITE.LIST_LIMIT);
  return docs.map(toInvite);
}

/**
 * Call when an email address is verified. Marks every pending invite to it as
 * joined and starts a direct chat with each person who invited them, so the
 * new user lands in a ready conversation. Never throws: sign-up must not fail
 * because of this.
 */
export async function acceptInvites(user: { id: string; email: string }): Promise<Conversation[]> {
  try {
    const pending = await Invite.find({ email: user.email, acceptedAt: null });
    if (pending.length === 0) return [];

    await Invite.updateMany({ _id: { $in: pending.map((invite) => invite._id) } }, { $set: { acceptedAt: new Date() } });

    const inviterIds = pending.map((invite) => invite.invitedBy.toString());
    const inviters = await User.find({ _id: { $in: inviterIds }, ...VERIFIED }).select('_id').lean();

    const conversations: Conversation[] = [];
    for (const inviter of inviters) {
      const { conversation, created } = await createConversation(user.id, {
        type: 'direct',
        userId: inviter._id.toString(),
      });
      if (created) conversations.push(conversation);
    }
    return conversations;
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Could not accept invites');
    return [];
  }
}
