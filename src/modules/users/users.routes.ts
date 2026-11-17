import { searchUsersQuerySchema, type UsersResponse } from '@chat/shared';
import { Router } from 'express';
import { parse } from '../../lib/parse';
import { getAuth } from '../../middleware/require-auth';
import { searchUsers } from './users.service';

export const usersRouter = Router();

/** GET /api/users?search=ali */
usersRouter.get('/', async (req, res) => {
  const { search } = parse(searchUsersQuerySchema, req.query);
  const users = await searchUsers(getAuth(req).userId, search);
  res.json({ users } satisfies UsersResponse);
});
