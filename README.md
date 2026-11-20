# WhatsApp Backend: Relay chat API

Real-time chat API: **Express 5 + MongoDB + Ably** in TypeScript, deployable as a Vercel serverless function, with email-verified sign-up (6-digit codes), rotating refresh tokens, conversations, messages, typing, presence and read receipts. The web app is in [whatsapp_frontend](https://github.com/RabiaMKhan/whatsapp_frontend).

## Stack

Express 5, Ably (real-time), Mongoose 9, Zod 4, jose (JWT), bcryptjs, nodemailer, helmet, express-rate-limit, pino. Tests: Vitest + Supertest against a real MongoDB test database (Ably events are captured in memory).

## Project structure

```
src/
  config/env.ts      Zod-validated env vars (the app exits if one is wrong)
  models/            User, Session, AuthCode, Conversation, Message
  modules/           auth · users · conversations · messages · invites · realtime (routes + services)
  realtime/          publisher: sends events to each member's Ably channel
  middleware/        requireAuth, CSRF header, rate limits, error handler
  lib/               tokens, mailer, email templates, serializers
  app.ts / server.ts Express app; plain HTTP server for local dev and tests
  vercel.ts          Vercel function entry (one MongoDB connection per warm instance)
scripts/seed.ts      demo users + chats
scripts/build-vercel.mjs  bundles the API into .vercel/output (Build Output API)
test/                auth, API, invites and realtime integration tests
packages/shared/     types + Zod schemas shared with the frontend
```

## Getting started

Requirements: Node 22+ and MongoDB running locally.

```bash
npm install
```

```bash
cp .env.example .env      # then set JWT_ACCESS_SECRET (and ABLY_API_KEY for live updates)
```

```bash
npm run seed              # demo users + chats (wipes the chat_app database)
```

```bash
npm run dev               # http://localhost:4000
```

Seeded users are verified; their password is `SEED_PASSWORD` in `scripts/seed.ts`. With `SMTP_HOST` empty, emails are not sent: the server prints each one (with the code) in its console.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with reload (tsx) |
| `npm test` | Integration tests (uses the `chat_app_test` database) |
| `npm run typecheck` | `tsc` for the server and the shared package |
| `npm run build` / `npm start` | Bundle with tsup / run the bundle |
| `npm run build:vercel` | Build the Vercel function into `.vercel/output` |
| `npm run seed` | Reset the local DB with demo data |

## Environment variables

`.env` (copy from `.env.example`):

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGODB_URI` | (required) | e.g. `mongodb://127.0.0.1:27017/chat_app` |
| `JWT_ACCESS_SECRET` | (required) | 32+ random characters |
| `CLIENT_ORIGINS` | `http://localhost:3005` | CORS allowlist, comma-separated |
| `ACCESS_TOKEN_TTL` | `15m` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh cookie lifetime |
| `COOKIE_SAMESITE` | `lax` | Use `none` (with HTTPS) only if web and API are on different sites |
| `TRUST_PROXY` | `0` | Number of proxies in front of the API (`1` on Vercel) |
| `ABLY_API_KEY` | (empty) | Ably key (Ably dashboard → API Keys). Empty → nothing is pushed live (dev). **Required in production** |
| `PORT` / `LOG_LEVEL` | `4000` / `info` | |
| `APP_URL` | `http://localhost:3005` | Frontend URL, used for links in emails |
| `SMTP_HOST` | (empty) | Empty → emails are printed in the console (dev). **Required in production** |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` | Use `465` / `true` for SSL |
| `SMTP_USER` / `SMTP_PASS` | (empty) | e.g. Gmail address + app password, or Mailtrap/Resend/Brevo SMTP keys |
| `EMAIL_FROM` | `Relay <no-reply@relay.local>` | Sender shown in the inbox |

## How auth works

**Account flow** (the same 6-digit-code approach as the blog app, finished and hardened):

```
register ──► email with 6-digit code ──► verify-email ──► signed in
                  ▲                            │
       resend-verification            login before verifying → 403 EMAIL_NOT_VERIFIED
       (60 s cooldown)                (and a new code is sent)

forgot-password ──► email with code ──► reset-password ──► signed out on every device
```

| Rule | Detail |
| --- | --- |
| Codes | 6 digits from `crypto.randomInt`, valid 10 min, one active code per user + purpose, deleted once used |
| Stored safely | Only an HMAC of the code (keyed by a server secret) is saved, never the code |
| Guessing | 5 wrong attempts and the code is locked; attempts are counted atomically (parallel guesses still count). Plus a per-IP rate limit |
| Resend | 60 s cooldown; the UI shows a countdown |
| No account probing | Unknown emails get the same answer on resend / forgot / reset. Login only says "not verified" after the password was right |
| Unverified sign-ups | A new sign-up with the same unverified email replaces the old one (stops "reserving" someone else's email). Unverified accounts can't be found in people search or added to chats |
| Reset password | Sets the new password, marks the email verified, ends every session, emails a "password changed" notice |
| Email HTML | Inline-styled templates; user names are HTML-escaped |

**Sessions:**

| Step | What happens |
| --- | --- |
| Verify / login | API returns an **access token** (JWT, 15 min, kept only in memory) and sets an **httpOnly refresh cookie** (`rt`, path `/api/auth`) |
| API calls | `Authorization: Bearer <access token>`. On a 401, the axios client calls `/auth/refresh` once and retries |
| Ably | The app asks `/realtime/token` (with the access token) for a signed Ably TokenRequest; Ably renews it by itself |
| Refresh | Cookie = `<sessionId>.<secret>`. The DB keeps only a SHA-256 hash. **Rotated on every refresh**. Reusing an old token ends the session (a 30 s grace window covers two tabs refreshing at once) |
| Page load | `/auth/refresh` restores the session from the cookie |
| Logout | Deletes the session and clears the cookie, then a full page reload wipes in-memory state |
| CSRF | Cookie routes need `X-Requested-With: XMLHttpRequest`, plus SameSite and the CORS allowlist |

**Frontend pages:** `/register` → `/verify-email` (6-box code input, auto-submits, resend countdown) · `/login` (unverified → sent to `/verify-email`) · `/forgot-password` → `/reset-password`. The pending email is kept in `sessionStorage`, never in the URL.

## REST API (`/api`)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | Creates an unverified account, emails a code. No session |
| POST | `/auth/verify-email` | `{ email, code }` → signed in (access token + cookie) |
| POST | `/auth/resend-verification` | `{ email }`, 60 s cooldown |
| POST | `/auth/login` | 403 `EMAIL_NOT_VERIFIED` if not verified yet |
| POST | `/auth/forgot-password` · `/auth/reset-password` | Code by email → `{ email, code, password }` |
| POST | `/auth/refresh` · `/auth/logout` | Cookie + CSRF header |
| GET | `/auth/me` | Current user |
| GET | `/users?search=` | People to chat with (never includes you) |
| GET | `/conversations` | Your chats, newest first, with `unreadCount` |
| POST | `/conversations` | `{ type: 'direct', userId }` or `{ type: 'group', name, memberIds }`. Direct chats are unique per pair |
| GET | `/conversations/:id` | 404 if you are not a member |
| GET | `/conversations/:id/messages?before=&limit=` | Cursor pages, oldest first, `nextCursor` |
| POST | `/conversations/:id/messages` | Send `{ body, clientId }`. Same `clientId` again → 200 with the saved message, no duplicate |
| POST | `/conversations/:id/typing` | `{ isTyping }` → the other members see it. 204 |
| POST | `/conversations/:id/read` | Mark as read |
| POST | `/invites` | `{ email }` → emails a sign-up link (201 `{ status: 'sent' }`). Already a member → no email, 200 `{ status: 'already_member', user }`. Same email again: 1 h cooldown; max 20 invites a day |
| GET | `/invites` | Invites you sent, with `pending` / `joined` |
| POST | `/realtime/token` | Ably TokenRequest: subscribe to `user:<you>`, presence on `online`. No publish rights |
| POST | `/users/me/heartbeat` | Saves `lastSeenAt` (the app calls it every 60 s). 204 |
| GET | `/health` | `{ status, db }` |

**Invites:** the email links to `/register?email=…`. When that address is verified on a new account, every pending invite to it becomes `joined` and a direct chat with each inviter is created (they get it live over `conversation:new`). No token is needed: verifying the email proves the invite reached its owner.

Errors always look like `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`.

## Real-time (Ably)

There is no socket server: every change is saved through the REST API, which then publishes an event with Ably. That is what lets the API run as serverless functions, where nothing stays open between requests.

```
browser ── POST /conversations/:id/messages ──► API ──► MongoDB
                                                  └──► Ably ──► user:<id> channel of every member
browser ◄──────────── message:new ──────────────────── Ably
```

Events are typed in `packages/shared/src/types/realtime.ts` (`RealtimeEvents`):

| Event (on `user:<id>`) | Payload | Sent to |
| --- | --- | --- |
| `message:new` | `Message` | every member, sender included (their other tabs) |
| `conversation:new` | `Conversation` | every member of a new chat |
| `conversation:read` | `{ conversationId, userId, lastReadAt }` | every member |
| `typing:update` | `{ conversationId, userId, isTyping }` | everyone in the chat except the typist |

- **Private channels:** each user's token may only *subscribe* to `user:<their id>`, so nobody can read someone else's events or publish fake ones. Only the API (with the key) publishes.
- **Online status:** Ably presence on the `online` channel; Ably sets each member's `clientId` from the token, so it can't be faked. "Last seen" is saved by the heartbeat route.
- **Reliability:** `clientId` makes sends idempotent, every payload is checked with Zod, sending and typing are rate-limited per user. A failed publish is logged and doesn't fail the request: clients refetch after reconnecting.
- **Tests:** with `NODE_ENV=test` events go to `testRealtimeOutbox` instead of Ably (see `test/realtime.test.ts`).

## Shared types (`packages/shared`)

Zod schemas, API response types and the typed real-time event contract. **The same folder lives in both `whatsapp_backend` and `whatsapp_frontend`.** When you change it in one repo, copy the change to the other so both sides keep the same contract. (Later this can become a published npm package or a git submodule.)

## Deploying (Vercel)

Both apps run on Vercel (no card needed):

- **API → Vercel project from this repo.** `vercel.json` runs `npm run build:vercel`, which bundles `src/vercel.ts` and every dependency into one Node function (`.vercel/output`, Build Output API) and routes every path to it. Env vars (Project → Settings → Environment Variables): `NODE_ENV=production`, `MONGODB_URI` (Atlas, database name in the path), `JWT_ACCESS_SECRET`, `ABLY_API_KEY`, `CLIENT_ORIGINS` + `APP_URL` (the web app's URL), `TRUST_PROXY=1`, and the SMTP settings.
- **Web app → Vercel** (`whatsapp_frontend`): it proxies `/api/*` to this API, so the refresh cookie stays first-party (Safari blocks cookies from another site). See the web app's README.
- **MongoDB Atlas:** allow `0.0.0.0/0` in Network Access (Vercel has no fixed IPs). The connection is reused while a function instance is warm.

## Scaling notes

- Presence lives in Ably, so any number of API instances work. The per-user and per-IP rate limits are in memory, so on serverless each instance counts on its own; use a Redis store (e.g. Upstash) for strict limits.
- The conversation preview is updated after the message insert with no transaction (a standalone MongoDB has none). Use a replica set if you need it atomic.
