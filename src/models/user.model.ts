import { LIMITS } from '@chat/shared';
import { Schema, model, type Types } from 'mongoose';

export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  avatarColor: string;
  /** null until the user enters the code from the verification email. */
  emailVerifiedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME_MAX },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    // select: false → never returned unless a query asks for '+passwordHash'.
    passwordHash: { type: String, required: true, select: false },
    avatarColor: { type: String, required: true },
    emailVerifiedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** Fields that are safe to send to other users. */
export const USER_PUBLIC_FIELDS = 'name email avatarColor lastSeenAt createdAt';

export const User = model<UserDoc>('User', userSchema);
