import {
  createConversationSchema,
  listMessagesQuerySchema,
  objectIdSchema,
  sendMessageSchema,
  type ConversationResponse,
  type ConversationsResponse,
  type CreateConversationResponse,
  type MessageResponse,
  type MessagesResponse,
  type ReadResponse,
} from '@chat/shared';
import { Router } from 'express';
import { parse } from '../../lib/parse';
import { getAuth } from '../../middleware/require-auth';
import { realtime } from '../../realtime/io';
import { listMessages, sendMessage } from '../messages/messages.service';
import {
  createConversation,
  getConversation,
  listConversations,
  markRead,
} from './conversations.service';

export const conversationsRouter = Router();

conversationsRouter.get('/', async (req, res) => {
  const conversations = await listConversations(getAuth(req).userId);
  res.json({ conversations } satisfies ConversationsResponse);
});

/** Start a direct chat ({ type: 'direct', userId }) or a group ({ type: 'group', name, memberIds }). */
conversationsRouter.post('/', async (req, res) => {
  const input = parse(createConversationSchema, req.body);
  const result = await createConversation(getAuth(req).userId, input);
  // Tell the other members right away, and put their sockets in the new room.
  if (result.created) realtime.conversationCreated(result.conversation);
  res.status(result.created ? 201 : 200).json(result satisfies CreateConversationResponse);
});

conversationsRouter.get('/:id', async (req, res) => {
  const id = parse(objectIdSchema, req.params.id);
  const conversation = await getConversation(id, getAuth(req).userId);
  res.json({ conversation } satisfies ConversationResponse);
});

/** GET /api/conversations/:id/messages?before=<messageId>&limit=30 */
conversationsRouter.get('/:id/messages', async (req, res) => {
  const id = parse(objectIdSchema, req.params.id);
  const query = parse(listMessagesQuerySchema, req.query);
  const page = await listMessages(id, getAuth(req).userId, query);
  res.json(page satisfies MessagesResponse);
});

/**
 * REST fallback for sending. The app normally sends over the socket
 * ('message:send'); both paths save and broadcast the same way.
 */
conversationsRouter.post('/:id/messages', async (req, res) => {
  const input = parse(sendMessageSchema, { ...req.body, conversationId: req.params.id });
  const { message, created } = await sendMessage(getAuth(req).userId, input);
  if (created) realtime.messageCreated(message);
  res.status(created ? 201 : 200).json({ message } satisfies MessageResponse);
});

conversationsRouter.post('/:id/read', async (req, res) => {
  const id = parse(objectIdSchema, req.params.id);
  const { userId } = getAuth(req);
  const lastReadAt = (await markRead(id, userId)).toISOString();
  realtime.conversationRead({ conversationId: id, userId, lastReadAt });
  res.json({ lastReadAt } satisfies ReadResponse);
});
