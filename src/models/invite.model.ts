import { Schema, model, type Types } from 'mongoose';

/**
 * An email invite from a signed-in user to someone without an account.
 * One document per (inviter, email): inviting again updates it.
 *
 * No token is stored: the invite link only pre-fills the sign-up form. The
 * invite counts as accepted when someone verifies that email address, which
 * proves they own the inbox the invite was sent to.
 */
export interface InviteDoc {
  _id: Types.ObjectId;
  email: string;
  invitedBy: Types.ObjectId;
  lastSentAt: Date;
  sendCount: number;
  /** Set when the invited email address is verified on a new account. */
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<InviteDoc>(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastSentAt: { type: Date, required: true },
    // No default: the upsert's $inc creates it (a default would clash with $inc on insert).
    sendCount: { type: Number },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

inviteSchema.index({ invitedBy: 1, email: 1 }, { unique: true });
// "Who invited this address?" when it signs up
inviteSchema.index({ email: 1, acceptedAt: 1 });
// The inviter's list and the daily limit
inviteSchema.index({ invitedBy: 1, lastSentAt: -1 });

export const Invite = model<InviteDoc>('Invite', inviteSchema);
