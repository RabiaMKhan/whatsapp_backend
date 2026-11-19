import type { AddressInfo } from 'node:net';
import { userChannel, type AuthResponse, type RealtimeEventName } from '@chat/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../src/db/connect';
import { testOutbox } from '../src/lib/mailer';
import { AuthCode } from '../src/models/auth-code.model';
import { Conversation } from '../src/models/conversation.model';
import { Invite } from '../src/models/invite.model';
import { Message } from '../src/models/message.model';
import { Session } from '../src/models/session.model';
import { User } from '../src/models/user.model';
import { testRealtimeOutbox, type PublishedEvent } from '../src/realtime/publisher';
import { createServer } from '../src/server';

/** Fresh test database + a real HTTP server on a random port. */
export async function startTestServer() {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Session.init(), AuthCode.init(), Conversation.init(), Message.init(), Invite.init()]);

  const { httpServer } = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await disconnectDatabase();
    },
  };
}

let userCounter = 0;

export const uniqueEmail = (name: string) => `${name.toLowerCase()}.${++userCounter}@example.com`;

/** Last email sent to this address (tests keep emails in memory). */
export function lastEmailTo(email: string) {
  const message = testOutbox.filter((m) => m.to === email).at(-1);
  if (!message) throw new Error(`No email was sent to ${email}`);
  return message;
}

export const emailsTo = (email: string) => testOutbox.filter((m) => m.to === email);

/** The 6-digit code in the last email to this address. */
export function lastCodeFor(email: string): string {
  const code = lastEmailTo(email).text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`No code in the last email to ${email}`);
  return code;
}

/** Sign up + verify the email with the emailed code → a signed-in user. */
export async function registerUser(baseUrl: string, name: string) {
  const agent = request.agent(baseUrl); // keeps the refresh cookie between requests
  const email = uniqueEmail(name);
  const password = 'test-password-123';
  await agent.post('/api/auth/register').send({ name, email, password }).expect(201);
  const res = await agent.post('/api/auth/verify-email').send({ email, code: lastCodeFor(email) }).expect(200);
  const body = res.body as AuthResponse;
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return {
    agent,
    email,
    password,
    user: body.user,
    token: body.accessToken,
    /** "rt=<value>" from the verify response. */
    refreshCookie: setCookie[0]?.split(';')[0] ?? '',
    auth: { Authorization: `Bearer ${body.accessToken}` },
  };
}

/* ---------- realtime (Ably) ---------- */

/** Events published to this user's channel so far (tests keep them in memory). */
export function eventsFor<E extends RealtimeEventName>(userId: string, name?: E): PublishedEvent<E>[] {
  return testRealtimeOutbox.filter(
    (event) => event.channels.includes(userChannel(userId)) && (!name || event.name === name),
  ) as PublishedEvent<E>[];
}

/** Payload of the last `name` event published to this user's channel. */
export function lastEventFor<E extends RealtimeEventName>(userId: string, name: E): PublishedEvent<E>['data'] {
  const event = eventsFor(userId, name).at(-1);
  if (!event) throw new Error(`No "${name}" event was published to user ${userId}`);
  return event.data;
}

/** Count events now, to check later that nothing new was published. */
export const outboxSize = () => testRealtimeOutbox.length;
