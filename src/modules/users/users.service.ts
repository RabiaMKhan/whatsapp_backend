import type { PublicUser } from '@chat/shared';
import { toPublicUser } from '../../lib/serializers';
import { USER_PUBLIC_FIELDS, User } from '../../models/user.model';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only verified accounts can be found and added to chats. */
export const VERIFIED = { emailVerifiedAt: { $ne: null } } as const;

/** People you can start a chat with: everyone verified except you, filtered by name or email. */
export async function searchUsers(currentUserId: string, search: string): Promise<PublicUser[]> {
  const filter: Record<string, unknown> = { _id: { $ne: currentUserId }, ...VERIFIED };
  if (search) {
    // Escape the input so "a.*" is searched literally, not run as a regex.
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: pattern }, { email: pattern }];
  }
  const users = await User.find(filter).select(USER_PUBLIC_FIELDS).sort({ name: 1 }).limit(20).lean();
  return users.map(toPublicUser);
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  const user = await User.findById(userId).select(USER_PUBLIC_FIELDS).lean();
  return user ? toPublicUser(user) : null;
}

export async function updateLastSeen(userId: string, at: Date): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { lastSeenAt: at } });
}
