import { createInviteSchema, type CreateInviteResponse, type InvitesResponse } from '@chat/shared';
import { Router } from 'express';
import { parse } from '../../lib/parse';
import { getAuth } from '../../middleware/require-auth';
import { inviteRateLimit } from '../../middleware/security';
import { createInvite, listInvites } from './invites.service';

export const invitesRouter = Router();

/** Invites I sent, newest first. */
invitesRouter.get('/', async (req, res) => {
  const invites = await listInvites(getAuth(req).userId);
  res.json({ invites } satisfies InvitesResponse);
});

/** POST /api/invites { email }: 201 when an email was sent, 200 when they already have an account. */
invitesRouter.post('/', inviteRateLimit, async (req, res) => {
  const input = parse(createInviteSchema, req.body);
  const result = await createInvite(getAuth(req).userId, input);
  res.status(result.status === 'sent' ? 201 : 200).json(result satisfies CreateInviteResponse);
});
