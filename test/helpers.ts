import type { AddressInfo } from 'node:net';
import type { AuthResponse, ClientToServerEvents, ServerToClientEvents } from '@chat/shared';
import mongoose from 'mongoose';
import { io as connectClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../src/db/connect';
import { testOutbox } from '../src/lib/mailer';
import { AuthCode } from '../src/models/auth-code.model';
import { Conversation } from '../src/models/conversation.model';
import { Invite } from '../src/models/invite.model';
import { Message } from '../src/models/message.model';
import { Session } from '../src/models/session.model';
import { User } from '../src/models/user.model';
import { createServer } from '../src/server';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Fresh test database + a real HTTP/Socket.io server on a random port. */
export async function startTestServer() {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Session.init(), AuthCode.init(), Conversation.init(), Message.init(), Invite.init()]);

  const { httpServer, io } = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await io.close();
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

export function connectSocket(baseUrl: string, token?: string): ClientSocket {
  return connectClient(baseUrl, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
}

/** Connect and wait until the server has finished setting up the socket. */
export async function connectReady(baseUrl: string, token: string): Promise<ClientSocket> {
  const socket = connectSocket(baseUrl, token);
  await new Promise<void>((resolve, reject) => {
    socket.once('presence:snapshot', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

type EventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

export function nextEvent<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  timeoutMs = 3_000,
): Promise<EventPayload<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    (socket as unknown as Socket).once(event as string, (payload: EventPayload<E>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves true if the event does NOT arrive within `ms`. */
export function noEvent(socket: ClientSocket, event: keyof ServerToClientEvents, ms = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const onEvent = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      (socket as unknown as Socket).off(event, onEvent);
      resolve(true);
    }, ms);
    (socket as unknown as Socket).once(event, onEvent);
  });
}
