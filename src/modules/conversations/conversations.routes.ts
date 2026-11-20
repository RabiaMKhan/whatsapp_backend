import {
  createConversationSchema,
  listMessagesQuerySchema,
  objectIdSchema,
  sendMessageSchema,
  typingSchema,
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
import { messageRateLimit, typingRateLimit } from '../../middleware/security';
import { realtime } from '../../realtime/publisher';
import { listMessages, sendMessage } from '../messages/messages.service';
import {
  createConversation,
  getConversation,
  listConversations,
  markRead,
  memberIdsFor,
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
  // Tell the other members right away.
  if (result.created) await realtime.conversationCreated(result.conversation);
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
 * Send a message ({ body, clientId }). Retrying with the same clientId returns
 * the saved message (200) instead of saving it twice.
 */
conversationsRouter.post('/:id/messages', messageRateLimit, async (req, res) => {
  const input = parse(sendMessageSchema, { ...req.body, conversationId: req.params.id });
  const { userId } = getAuth(req);
  const { message, created } = await sendMessage(userId, input);
  if (created) await realtime.messageCreated(message);
  res.status(created ? 201 : 200).json({ message } satisfies MessageResponse);
});

/**
 * { isTyping } → the other members see "… is typing". The app repeats
 * isTyping: true every few seconds while typing, and the others hide the
 * indicator if nothing arrives for a while, so a lost "stop" is harmless.
 */
conversationsRouter.post('/:id/typing', typingRateLimit, async (req, res) => {
  const conversationId = parse(objectIdSchema, req.params.id);
  const { isTyping } = parse(typingSchema, req.body);
  const { userId } = getAuth(req);
  const members = await memberIdsFor(conversationId, userId); // 404 for non-members
  await realtime.typing({ conversationId, userId, isTyping }, members);
  res.status(204).end();
});

conversationsRouter.post('/:id/read', async (req, res) => {
  const id = parse(objectIdSchema, req.params.id);
  const { userId } = getAuth(req);
  const lastReadAt = (await markRead(id, userId)).toISOString();
  await realtime.conversationRead({ conversationId: id, userId, lastReadAt });
  res.json({ lastReadAt } satisfies ReadResponse);
});
