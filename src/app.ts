import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { isDatabaseUp } from './db/connect';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requireAuth } from './middleware/require-auth';
import { authRouter } from './modules/auth/auth.routes';
import { conversationsRouter } from './modules/conversations/conversations.routes';
import { usersRouter } from './modules/users/users.routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind a proxy (Render, Railway, Nginx) this makes req.ip the real client IP.
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.get('/health', (_req, res) => {
    const db = isDatabaseUp();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db: db ? 'up' : 'down' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/conversations', requireAuth, conversationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
