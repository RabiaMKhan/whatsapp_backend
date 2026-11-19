import {
  userChannel,
  type Conversation,
  type Message,
  type ReadReceiptPayload,
  type RealtimeEventName,
  type RealtimeEvents,
  type TypingPayload,
} from '@chat/shared';
import Ably from 'ably';
import { env, isTest } from '../config/env';
import { logger } from '../lib/logger';
import { Conversation as ConversationModel } from '../models/conversation.model';

/*
 * Real-time updates go through Ably instead of a socket server, so the API can
 * run as serverless functions (Vercel), where nothing stays open between
 * requests.
 *
 *   route saves the change ──► publisher ──► Ably ──► user:<id> channel of each member
 *
 * Every event goes to each member's PRIVATE channel. A user's Ably token may
 * only subscribe to their own channel (see realtime.routes.ts), so nobody can
 * read other people's events or publish fake ones.
 *
 * Three modes, like the mailer:
 *  - ABLY_API_KEY set → publish to Ably.
 *  - Tests → kept in `testRealtimeOutbox` so tests can check what was sent.
 *  - Development without a key → logged and skipped (REST still works).
 */

const rest = env.ABLY_API_KEY ? new Ably.Rest({ key: env.ABLY_API_KEY }) : null;

/** The Ably client for routes that need it (token requests). null without a key. */
export const ablyRest = rest;

export interface PublishedEvent<E extends RealtimeEventName = RealtimeEventName> {
  channels: string[];
  name: E;
  data: RealtimeEvents[E];
}

export const testRealtimeOutbox: PublishedEvent[] = [];

async function publish<E extends RealtimeEventName>(userIds: string[], name: E, data: RealtimeEvents[E]): Promise<void> {
  const channels = [...new Set(userIds)].map(userChannel);
  if (channels.length === 0) return;

  if (isTest) {
    testRealtimeOutbox.push({ channels, name, data } as PublishedEvent);
    return;
  }
  if (!rest) {
    logger.debug({ name, channels: channels.length }, 'Realtime event skipped (ABLY_API_KEY is not set)');
    return;
  }

  // One request for all members. A failed publish must not fail the request
  // that caused it (the change is already saved; clients catch up on reload).
  try {
    await rest.batchPublish({ channels, messages: [{ name, data }] });
  } catch (err) {
    logger.error({ err, name }, 'Could not publish realtime event');
  }
}

async function memberIds(conversationId: string): Promise<string[]> {
  const doc = await ConversationModel.findById(conversationId, { 'members.user': 1 }).lean();
  return doc?.members.map((member) => member.user.toString()) ?? [];
}

/**
 * Called by routes after a change is saved. Each one is awaited before the
 * response is sent: on serverless platforms work left running after the
 * response may be frozen.
 */
export const realtime = {
  /** Every member, the sender included: their other tabs need it too. */
  async messageCreated(message: Message) {
    await publish(await memberIds(message.conversationId), 'message:new', message);
  },

  async conversationCreated(conversation: Conversation) {
    await publish(
      conversation.members.map((member) => member.user.id),
      'conversation:new',
      conversation,
    );
  },

  async conversationRead(payload: ReadReceiptPayload) {
    await publish(await memberIds(payload.conversationId), 'conversation:read', payload);
  },

  /** Everyone in the chat except the person typing. */
  async typing(payload: TypingPayload, memberIdsInChat: string[]) {
    await publish(
      memberIdsInChat.filter((id) => id !== payload.userId),
      'typing:update',
      payload,
    );
  },
};
