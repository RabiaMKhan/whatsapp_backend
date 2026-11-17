import { Schema, model, type Types } from 'mongoose';

export type AuthCodePurpose = 'verify_email' | 'reset_password';

/**
 * A one-time 6-digit code sent by email. At most one active code per user and
 * purpose: sending a new one replaces the old one.
 */
export interface AuthCodeDoc {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  purpose: AuthCodePurpose;
  /** HMAC of the code, never the code itself. */
  codeHash: string;
  expiresAt: Date;
  /** Wrong guesses so far. */
  attempts: number;
  /** For the resend cooldown. */
  lastSentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const authCodeSchema = new Schema<AuthCodeDoc>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: ['verify_email', 'reset_password'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

authCodeSchema.index({ user: 1, purpose: 1 }, { unique: true });
// MongoDB deletes codes by itself once they expire.
authCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthCode = model<AuthCodeDoc>('AuthCode', authCodeSchema);
