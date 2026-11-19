import { REALTIME, userChannel, type Conversation } from '@chat/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Message } from '../src/models/message.model';
import { User } from '../src/models/user.model';
import { eventsFor, lastEventFor, outboxSize, registerUser, startTestServer } from './helpers';

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;

beforeAll(async () => {
  server = await startTestServer();
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  await server.stop();
});

async function startChat(from: Awaited<ReturnType<typeof registerUser>>, toUserId: string) {
  const res = await request(baseUrl).post('/api/conversations').set(from.auth).send({ type: 'direct', userId: toUserId }).expect(201);
  return res.body.conversation as Conversation;
}

describe('Ably token', () => {
  it('needs a signed-in user', async () => {
    await request(baseUrl).post('/api/realtime/token').expect(401);
  });

  it('only lets the user subscribe to their own channel and use presence', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const res = await request(baseUrl).post('/api/realtime/token').set(alice.auth).expect(200);

    expect(res.body).toMatchObject({
      keyName: 'testapp.testkey',
      clientId: alice.user.id,
      ttl: REALTIME.TOKEN_TTL_MINUTES * 60 * 1000,
      mac: expect.any(String),
    });
    expect(JSON.parse(res.body.capability)).toEqual({
      [userChannel(alice.user.id)]: ['subscribe'],
      [REALTIME.ONLINE_CHANNEL]: ['presence', 'subscribe'],
    });
    // The secret half of the API key never leaves the server.
    expect(JSON.stringify(res.body)).not.toContain('not-a-real-secret');
  });
});

describe('real-time chat', () => {
  it('publishes new chats, typing, messages and read receipts to the right members', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const bob = await registerUser(baseUrl, 'Bob');

    // Alice starts a chat → both get conversation:new (Alice's other tabs too).
    const conversation = await startChat(alice, bob.user.id);
    expect(lastEventFor(bob.user.id, 'conversation:new').id).toBe(conversation.id);
    expect(lastEventFor(alice.user.id, 'conversation:new').id).toBe(conversation.id);

    // Typing → only the OTHER member hears it.
    const aliceTypingBefore = eventsFor(alice.user.id, 'typing:update').length;
    await request(baseUrl)
      .post(`/api/conversations/${conversation.id}/typing`)
      .set(alice.auth)
      .send({ isTyping: true })
      .expect(204);
    expect(lastEventFor(bob.user.id, 'typing:update')).toEqual({
      conversationId: conversation.id,
      userId: alice.user.id,
      isTyping: true,
    });
    expect(eventsFor(alice.user.id, 'typing:update')).toHaveLength(aliceTypingBefore);

    // Send a message → message:new to both members, body trimmed.
    const sent = await request(baseUrl)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(alice.auth)
      .send({ body: '  Hello Bob  ', clientId: 'c-1' })
      .expect(201);
    const message = lastEventFor(bob.user.id, 'message:new');
    expect(message).toMatchObject({ id: sent.body.message.id, body: 'Hello Bob', senderId: alice.user.id, clientId: 'c-1' });
    expect(lastEventFor(alice.user.id, 'message:new').id).toBe(message.id);

    // Retry with the same clientId → same message, nothing published again, no duplicate row.
    const before = outboxSize();
    const retry = await request(baseUrl)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(alice.auth)
      .send({ body: 'Hello Bob', clientId: 'c-1' })
      .expect(200);
    expect(retry.body.message.id).toBe(message.id);
    expect(outboxSize()).toBe(before);
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(1);

    // Invalid body → 400, nothing published.
    await request(baseUrl)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(alice.auth)
      .send({ body: '   ', clientId: 'c-2' })
      .expect(400);
    await request(baseUrl)
      .post(`/api/conversations/${conversation.id}/typing`)
      .set(alice.auth)
      .send({ isTyping: 'yes' })
      .expect(400);
    expect(outboxSize()).toBe(before);

    // Read receipt → both members.
    await request(baseUrl).post(`/api/conversations/${conversation.id}/read`).set(bob.auth).expect(200);
    expect(lastEventFor(alice.user.id, 'conversation:read')).toMatchObject({ conversationId: conversation.id, userId: bob.user.id });
  });

  it('keeps non-members out and publishes nothing for them', async () => {
    const alice = await registerUser(baseUrl, 'Ann');
    const bob = await registerUser(baseUrl, 'Ben');
    const mallory = await registerUser(baseUrl, 'Mallory');
    const conversation = await startChat(alice, bob.user.id);
    const before = outboxSize();

    const base = `/api/conversations/${conversation.id}`;
    await request(baseUrl).post(`${base}/messages`).set(mallory.auth).send({ body: 'hi', clientId: 'm-1' }).expect(404);
    await request(baseUrl).post(`${base}/read`).set(mallory.auth).expect(404);
    await request(baseUrl).post(`${base}/typing`).set(mallory.auth).send({ isTyping: true }).expect(404);

    expect(outboxSize()).toBe(before);
    expect(eventsFor(mallory.user.id)).toHaveLength(0);
  });
});

describe('last seen heartbeat', () => {
  it('saves lastSeenAt for the signed-in user', async () => {
    await request(baseUrl).post('/api/users/me/heartbeat').expect(401);

    const alice = await registerUser(baseUrl, 'Alice');
    const startedAt = Date.now();
    await request(baseUrl).post('/api/users/me/heartbeat').set(alice.auth).expect(204);

    const saved = await User.findById(alice.user.id).lean();
    expect(saved?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
  });
});
