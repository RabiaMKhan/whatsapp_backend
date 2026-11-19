import { INVITE, type ConversationsResponse, type CreateInviteResponse, type InvitesResponse } from '@chat/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectReady, emailsTo, lastCodeFor, lastEmailTo, nextEvent, registerUser, startTestServer, uniqueEmail } from './helpers';

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;

beforeAll(async () => {
  server = await startTestServer();
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  await server.stop();
});

const invite = (auth: Record<string, string>, email: string) =>
  request(baseUrl).post('/api/invites').set(auth).send({ email });

describe('invites', () => {
  it('needs a signed-in user', async () => {
    const res = await request(baseUrl).post('/api/invites').send({ email: 'someone@example.com' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('emails a sign-up link and lists the invite as pending', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const email = uniqueEmail('Friend');

    const res = await invite(alice.auth, `  ${email.toUpperCase()} `).expect(201);
    const body = res.body as CreateInviteResponse;
    expect(body.status).toBe('sent');

    const message = lastEmailTo(email);
    expect(message.kind).toBe('invite');
    expect(message.subject).toBe('Alice invited you to chat on Relay');
    expect(message.text).toContain(`/register?email=${encodeURIComponent(email)}`);
    expect(message.html).toContain('Join Relay');

    const list = await request(baseUrl).get('/api/invites').set(alice.auth).expect(200);
    expect((list.body as InvitesResponse).invites).toEqual([
      expect.objectContaining({ email, status: 'pending', joinedAt: null }),
    ]);
  });

  it('validates the email with the shared schema', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const res = await invite(alice.auth, 'not-an-email').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("refuses the user's own email", async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const res = await invite(alice.auth, alice.email).expect(400);
    expect(res.body.error.message).toMatch(/your own email/);
  });

  it('sends nothing when the person already has an account, and returns them instead', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const bob = await registerUser(baseUrl, 'Bob');
    const emailsBefore = emailsTo(bob.email).length;

    const res = await invite(alice.auth, bob.email).expect(200);
    const body = res.body as CreateInviteResponse;
    expect(body).toEqual({ status: 'already_member', user: expect.objectContaining({ id: bob.user.id, name: 'Bob' }) });
    expect(emailsTo(bob.email)).toHaveLength(emailsBefore);
  });

  it('still invites an address whose sign-up was never verified', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const email = uniqueEmail('Halfway');
    await request(baseUrl).post('/api/auth/register').send({ name: 'Halfway', email, password: 'test-password-123' }).expect(201);

    const res = await invite(alice.auth, email).expect(201);
    expect((res.body as CreateInviteResponse).status).toBe('sent');
  });

  it('waits an hour before the same person can invite the same email again', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const carol = await registerUser(baseUrl, 'Carol');
    const email = uniqueEmail('Friend');

    await invite(alice.auth, email).expect(201);
    const again = await invite(alice.auth, email).expect(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(INVITE.RESEND_COOLDOWN_MINUTES * 60 - 60);
    expect(emailsTo(email)).toHaveLength(1);

    // Someone else can still invite them.
    await invite(carol.auth, email).expect(201);
    expect(emailsTo(email)).toHaveLength(2);
  });

  it(`stops after ${INVITE.DAILY_LIMIT} invites a day`, async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    for (let i = 0; i < INVITE.DAILY_LIMIT; i++) {
      await invite(alice.auth, uniqueEmail('Bulk')).expect(201);
    }
    const res = await invite(alice.auth, uniqueEmail('Bulk')).expect(429);
    expect(res.body.error.message).toMatch(/invites a day/);
  });

  it('escapes the inviter name in the email HTML', async () => {
    // registerUser builds the email from the name, so sign this one up by hand.
    const eveEmail = uniqueEmail('Eve');
    await request(baseUrl).post('/api/auth/register').send({ name: '<b>Eve</b>', email: eveEmail, password: 'test-password-123' }).expect(201);
    const eve = await request(baseUrl).post('/api/auth/verify-email').send({ email: eveEmail, code: lastCodeFor(eveEmail) }).expect(200);

    const email = uniqueEmail('Target');
    await invite({ Authorization: `Bearer ${eve.body.accessToken}` }, email).expect(201);
    const { html } = lastEmailTo(email);
    expect(html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(html).not.toContain('<b>Eve</b>');
  });

  it('marks the invite joined and starts a chat with the inviter when they sign up', async () => {
    const alice = await registerUser(baseUrl, 'Alice');
    const email = uniqueEmail('Newbie');
    await invite(alice.auth, email).expect(201);

    const aliceSocket = await connectReady(baseUrl, alice.token);
    try {
      const chatCreated = nextEvent(aliceSocket, 'conversation:new');

      // The invited person signs up with the invited address and verifies it.
      await request(baseUrl).post('/api/auth/register').send({ name: 'Newbie', email, password: 'test-password-123' }).expect(201);
      const verified = await request(baseUrl).post('/api/auth/verify-email').send({ email, code: lastCodeFor(email) }).expect(200);

      const conversation = await chatCreated;
      expect(conversation.type).toBe('direct');
      expect(conversation.members.map((m) => m.user.email).sort()).toEqual([alice.email, email].sort());

      const theirChats = await request(baseUrl)
        .get('/api/conversations')
        .set({ Authorization: `Bearer ${verified.body.accessToken}` })
        .expect(200);
      expect((theirChats.body as ConversationsResponse).conversations.map((c) => c.id)).toEqual([conversation.id]);

      const list = await request(baseUrl).get('/api/invites').set(alice.auth).expect(200);
      expect((list.body as InvitesResponse).invites[0]).toEqual(
        expect.objectContaining({ email, status: 'joined', joinedAt: expect.any(String) }),
      );
    } finally {
      aliceSocket.disconnect();
    }
  });
});
