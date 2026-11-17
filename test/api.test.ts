import type { Conversation, ConversationsResponse, MessagesResponse } from '@chat/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../src/models/session.model';
import { registerUser, startTestServer } from './helpers';

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  server = await startTestServer();
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  await server.stop();
});

describe('health', () => {
  it('reports the database as up', async () => {
    const res = await request(baseUrl).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });
});

describe('session', () => {
  it('validates input with the shared Zod schema', async () => {
    const res = await request(baseUrl)
      .post('/api/auth/register')
      .send({ name: 'Bo', email: 'not-an-email', password: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'email' }), expect.objectContaining({ path: 'password' })]),
    );
  });

  it('logs in with the right password only, with the same error for unknown emails', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const wrong = await request(baseUrl)
      .post('/api/auth/login')
      .send({ email: alice.email, password: 'wrong-password' })
      .expect(401);
    const unknown = await request(baseUrl)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const ok = await request(baseUrl).post('/api/auth/login').send({ email: alice.email, password: alice.password }).expect(200);
    const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? [])[0] ?? '';
    expect(cookie).toMatch(/^rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(ok.body.user).not.toHaveProperty('passwordHash');
  });

  it('protects routes with the access token', async () => {
    await request(baseUrl).get('/api/auth/me').expect(401);
    await request(baseUrl).get('/api/auth/me').set('Authorization', 'Bearer not-a-real-token').expect(401);

    const me = await registerUser(baseUrl, 'Me');
    const res = await request(baseUrl).get('/api/auth/me').set(me.auth).expect(200);
    expect(res.body.user.id).toBe(me.user.id);
  });

  it('requires the CSRF header on refresh', async () => {
    const user = await registerUser(baseUrl, 'Csrf');
    await user.agent.post('/api/auth/refresh').expect(403);
    await user.agent.post('/api/auth/refresh').set(CSRF).expect(200);
  });

  it('rotates the refresh token and revokes the session when an old token is reused', async () => {
    const user = await registerUser(baseUrl, 'Rotate');

    const first = await user.agent.post('/api/auth/refresh').set(CSRF).expect(200);
    const rotated = ([] as string[]).concat(first.headers['set-cookie'] ?? [])[0]?.split(';')[0];
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(user.refreshCookie);

    // Old token inside the grace window (two tabs refreshing together): accepted, cookie left alone.
    const grace = await request(baseUrl).post('/api/auth/refresh').set(CSRF).set('Cookie', user.refreshCookie).expect(200);
    expect(grace.headers['set-cookie']).toBeUndefined();

    // Grace window over: reusing the old token looks like theft, so the whole session ends.
    await Session.updateMany({ user: user.user.id }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });
    await request(baseUrl).post('/api/auth/refresh').set(CSRF).set('Cookie', user.refreshCookie).expect(401);
    await user.agent.post('/api/auth/refresh').set(CSRF).expect(401);
  });

  it('logout ends the session', async () => {
    const user = await registerUser(baseUrl, 'Logout');
    await user.agent.post('/api/auth/logout').set(CSRF).expect(204);
    await request(baseUrl).post('/api/auth/refresh').set(CSRF).set('Cookie', user.refreshCookie).expect(401);
  });
});

describe('users', () => {
  it('searches other users by name or email, never including yourself', async () => {
    const searcher = await registerUser(baseUrl, 'Searcher');
    await registerUser(baseUrl, 'Zelda');

    const res = await request(baseUrl).get('/api/users').query({ search: 'zel' }).set(searcher.auth).expect(200);
    expect(res.body.users.map((u: { name: string }) => u.name)).toEqual(['Zelda']);

    const all = await request(baseUrl).get('/api/users').set(searcher.auth).expect(200);
    expect(all.body.users.some((u: { id: string }) => u.id === searcher.user.id)).toBe(false);

    // Regex characters are searched literally.
    await request(baseUrl).get('/api/users').query({ search: '.*' }).set(searcher.auth).expect(200);
  });
});

describe('conversations', () => {
  it('creates one direct chat per pair of users', async () => {
    const a = await registerUser(baseUrl, 'Dana');
    const b = await registerUser(baseUrl, 'Eli');

    const created = await request(baseUrl)
      .post('/api/conversations')
      .set(a.auth)
      .send({ type: 'direct', userId: b.user.id })
      .expect(201);
    expect(created.body.created).toBe(true);
    expect(created.body.conversation.members).toHaveLength(2);

    const again = await request(baseUrl)
      .post('/api/conversations')
      .set(b.auth)
      .send({ type: 'direct', userId: a.user.id })
      .expect(200);
    expect(again.body).toMatchObject({ created: false, conversation: { id: created.body.conversation.id } });

    await request(baseUrl).post('/api/conversations').set(a.auth).send({ type: 'direct', userId: a.user.id }).expect(400);
  });

  it('creates a group with the creator as owner', async () => {
    const owner = await registerUser(baseUrl, 'Owner');
    const m1 = await registerUser(baseUrl, 'Member1');
    const m2 = await registerUser(baseUrl, 'Member2');

    const res = await request(baseUrl)
      .post('/api/conversations')
      .set(owner.auth)
      .send({ type: 'group', name: 'Launch', memberIds: [m1.user.id, m2.user.id] })
      .expect(201);
    const conversation = res.body.conversation as Conversation;
    expect(conversation).toMatchObject({ type: 'group', name: 'Launch' });
    expect(conversation.members.find((m) => m.user.id === owner.user.id)?.role).toBe('owner');
  });

  it('sends, paginates, counts unread, marks read, and ignores retried messages', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const bob = await registerUser(baseUrl, 'Bob');
    const carol = await registerUser(baseUrl, 'Carol');

    const { body } = await request(baseUrl)
      .post('/api/conversations')
      .set(alice.auth)
      .send({ type: 'direct', userId: bob.user.id })
      .expect(201);
    const id = body.conversation.id as string;

    for (const [i, text] of ['one', 'two', 'three'].entries()) {
      await request(baseUrl)
        .post(`/api/conversations/${id}/messages`)
        .set(alice.auth)
        .send({ body: text, clientId: `c-${i}` })
        .expect(201);
    }

    // Retry with the same clientId → same message, nothing new saved.
    const retry = await request(baseUrl)
      .post(`/api/conversations/${id}/messages`)
      .set(alice.auth)
      .send({ body: 'three', clientId: 'c-2' })
      .expect(200);
    expect(retry.body.message.body).toBe('three');

    const unreadFor = async (who: typeof bob) => {
      const res = await request(baseUrl).get('/api/conversations').set(who.auth).expect(200);
      return (res.body as ConversationsResponse).conversations.find((c) => c.id === id)?.unreadCount;
    };
    expect(await unreadFor(bob)).toBe(3);
    expect(await unreadFor(alice)).toBe(0); // your own messages are never unread

    const page1 = (await request(baseUrl).get(`/api/conversations/${id}/messages?limit=2`).set(bob.auth).expect(200))
      .body as MessagesResponse;
    expect(page1.messages.map((m) => m.body)).toEqual(['two', 'three']); // oldest first
    expect(page1.nextCursor).toBeTruthy();

    const page2 = (
      await request(baseUrl).get(`/api/conversations/${id}/messages?limit=2&before=${page1.nextCursor}`).set(bob.auth).expect(200)
    ).body as MessagesResponse;
    expect(page2.messages.map((m) => m.body)).toEqual(['one']);
    expect(page2.nextCursor).toBeNull();

    await request(baseUrl).post(`/api/conversations/${id}/read`).set(bob.auth).expect(200);
    expect(await unreadFor(bob)).toBe(0);

    // Not a member → 404 everywhere (does not reveal that the chat exists).
    await request(baseUrl).get(`/api/conversations/${id}`).set(carol.auth).expect(404);
    await request(baseUrl).get(`/api/conversations/${id}/messages`).set(carol.auth).expect(404);
    await request(baseUrl).post(`/api/conversations/${id}/messages`).set(carol.auth).send({ body: 'hi', clientId: 'x' }).expect(404);
    await request(baseUrl).get('/api/conversations/not-an-id').set(carol.auth).expect(400);
  });
});
