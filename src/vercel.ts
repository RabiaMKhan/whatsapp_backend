import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app';
import { connectDatabase } from './db/connect';

/*
 * Vercel entry point (bundled by scripts/build-vercel.mjs into a single
 * serverless function). Every request runs this handler.
 *
 * A function instance is reused for many requests while it stays warm, so the
 * app and the MongoDB connection are created once per instance, not per
 * request. If connecting fails, the next request tries again.
 */
const app = createApp();
let ready: Promise<void> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= connectDatabase().catch((err: unknown) => {
    ready = null;
    throw err;
  });
  await ready;
  app(req, res);
}
