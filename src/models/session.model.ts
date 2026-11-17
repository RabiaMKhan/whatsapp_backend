import { Schema, model, type Types } from 'mongoose';

/** One row per signed-in device/browser. Holds the hash of its refresh token. */
export interface SessionDoc {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  /** Hash of the token before the last rotation (see auth.service refresh()). */
  previousTokenHash: string | null;
  rotatedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true },
    previousTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// TTL index: MongoDB deletes a session by itself once expiresAt has passed.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<SessionDoc>('Session', sessionSchema);
