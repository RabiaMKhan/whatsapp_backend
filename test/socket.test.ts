import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Message } from '../src/models/message.model';
import { connectReady, connectSocket, nextEvent, noEvent, registerUser, startTestServer, type ClientSocket } from './helpers';

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;
const sockets: ClientSocket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await server.stop();
});

async function connect(token: string) {
  const socket = await connectReady(baseUrl, token);
  sockets.push(socket);
  return socket;
}

describe('socket auth', () => {
  it('rejects connections without a valid access token', async () => {
    for (const token of [undefined, 'garbage']) {
      const socket = connectSocket(baseUrl, token);
      const err = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
      expect(err.message).toBe('UNAUTHORIZED');
      socket.close();
    }
  });
});

describe('real-time chat', () => {
  it('handles presence, new chats, typing, messages, retries and read receipts', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const bob = await registerUser(baseUrl, 'Bob');

    const aliceSocket = await connect(alice.token);

    // Bob comes online → Alice is told.
    const bobOnline = nextEvent(aliceSocket, 'presence:update');
    const bobSocket = await connect(bob.token);
    expect(await bobOnline).toMatchObject({ userId: bob.user.id, online: true });

    // Alice starts a chat over REST → Bob gets it live and joins its room.
    const bobNewChat = nextEvent(bobSocket, 'conversation:new');
    const { body } = await request(baseUrl)
      .post('/api/conversations')
      .set(alice.auth)
      .send({ type: 'direct', userId: bob.user.id })
      .expect(201);
    const conversationId = body.conversation.id as string;
    expect((await bobNewChat).id).toBe(conversationId);

    // Typing indicator.
    const bobSeesTyping = nextEvent(bobSocket, 'typing:update');
    aliceSocket.emit('typing:start', { conversationId });
    expect(await bobSeesTyping).toEqual({ conversationId, userId: alice.user.id, isTyping: true });

    // Send a message: ack to Alice, message:new to Bob, and typing stops.
    const bobGetsMessage = nextEvent(bobSocket, 'message:new');
    const bobSeesTypingStop = nextEvent(bobSocket, 'typing:update');
    const ack = await aliceSocket.emitWithAck('message:send', { conversationId, body: '  Hello Bob  ', clientId: 'c-1' });
    expect(ack.ok).toBe(true);
    const message = await bobGetsMessage;
    expect(message).toMatchObject({ conversationId, body: 'Hello Bob', senderId: alice.user.id, clientId: 'c-1' });
    expect(await bobSeesTypingStop).toMatchObject({ isTyping: false });

    // Retry with the same clientId → same message back, no second broadcast, no duplicate row.
    const noDuplicate = noEvent(bobSocket, 'message:new');
    const retry = await aliceSocket.emitWithAck('message:send', { conversationId, body: 'Hello Bob', clientId: 'c-1' });
    expect(retry.ok && retry.data.id).toBe(message.id);
    expect(await noDuplicate).toBe(true);
    expect(await Message.countDocuments({ conversation: conversationId })).toBe(1);

    // Invalid payload → error ack, nothing saved.
    const invalid = await aliceSocket.emitWithAck('message:send', { conversationId, body: '   ', clientId: 'c-2' });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });

    // Read receipt.
    const aliceSeesRead = nextEvent(aliceSocket, 'conversation:read');
    const readAck = await bobSocket.emitWithAck('conversation:read', { conversationId });
    expect(readAck.ok).toBe(true);
    expect(await aliceSeesRead).toMatchObject({ conversationId, userId: bob.user.id });

    // Bob closes his only tab → Alice sees him go offline.
    const bobOffline = nextEvent(aliceSocket, 'presence:update');
    bobSocket.close();
    expect(await bobOffline).toMatchObject({ userId: bob.user.id, online: false });
  });

  it('keeps non-members out of a conversation', async () => {
    const alice = await registerUser(baseUrl, 'Ann');
    const bob = await registerUser(baseUrl, 'Ben');
    const mallory = await registerUser(baseUrl, 'Mallory');

    const { body } = await request(baseUrl)
      .post('/api/conversations')
      .set(alice.auth)
      .send({ type: 'direct', userId: bob.user.id })
      .expect(201);
    const conversationId = body.conversation.id as string;

    const bobSocket = await connect(bob.token);
    const malloraySocket = await connect(mallory.token);

    const send = await malloraySocket.emitWithAck('message:send', { conversationId, body: 'hi', clientId: 'm-1' });
    expect(send).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const read = await malloraySocket.emitWithAck('conversation:read', { conversationId });
    expect(read).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const bobUndisturbed = noEvent(bobSocket, 'typing:update');
    malloraySocket.emit('typing:start', { conversationId });
    expect(await bobUndisturbed).toBe(true);
  });
});
