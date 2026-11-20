import { ERROR_CODES, REALTIME, userChannel } from '@chat/shared';
import { Router } from 'express';
import { HttpError } from '../../lib/http-error';
import { getAuth } from '../../middleware/require-auth';
import { ablyRest } from '../../realtime/publisher';

export const realtimeRouter = Router();

/**
 * POST /api/realtime/token → an Ably TokenRequest for the signed-in user.
 *
 * The web app's Ably client calls this (authCallback) to connect, and again
 * by itself before the token expires. The API key never leaves the server:
 * the TokenRequest is signed with it, and Ably checks the signature.
 *
 * What the token allows:
 *  - user:<me>  subscribe          → my own events; nobody else's channel
 *  - online     presence+subscribe → show me as online, see who else is
 * No publish anywhere: only the API (with the key) sends events.
 */
realtimeRouter.post('/token', async (req, res) => {
  if (!ablyRest) {
    throw new HttpError(503, ERROR_CODES.INTERNAL_ERROR, 'Real-time updates are not configured on the server.');
  }
  const { userId } = getAuth(req);
  const tokenRequest = await ablyRest.auth.createTokenRequest({
    clientId: userId, // Ably stamps this on presence, so it can't be faked
    capability: {
      [userChannel(userId)]: ['subscribe'],
      [REALTIME.ONLINE_CHANNEL]: ['presence', 'subscribe'],
    },
    ttl: REALTIME.TOKEN_TTL_MINUTES * 60 * 1000,
  });
  res.json(tokenRequest);
});
