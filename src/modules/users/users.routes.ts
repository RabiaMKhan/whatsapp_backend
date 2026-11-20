import { searchUsersQuerySchema, type UsersResponse } from '@chat/shared';
import { Router } from 'express';
import { parse } from '../../lib/parse';
import { getAuth } from '../../middleware/require-auth';
import { searchUsers, updateLastSeen } from './users.service';

export const usersRouter = Router();

/** GET /api/users?search=ali */
usersRouter.get('/', async (req, res) => {
  const { search } = parse(searchUsersQuerySchema, req.query);
  const users = await searchUsers(getAuth(req).userId, search);
  res.json({ users } satisfies UsersResponse);
});

/**
 * The app calls this every REALTIME.HEARTBEAT_SECONDS while it is open, so
 * "last seen" stays roughly right. Ably presence shows who is online now.
 */
usersRouter.post('/me/heartbeat', async (req, res) => {
  await updateLastSeen(getAuth(req).userId, new Date());
  res.status(204).end();
});
