import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import { logger } from '../lib/logger';

/*
 * One short line per request:
 *
 *   14:05:12 INFO: POST /api/auth/login 200 12ms
 *   14:05:13 ERROR: GET /api/conversations 500 31ms
 *
 * Only method, URL, status and time are kept. Headers and cookies are left
 * out: they are noisy, and they can contain tokens.
 */

// Express rewrites req.url inside routers; originalUrl is the full path.
const pathOf = (req: IncomingMessage) => (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url;

export const requestLogger = pinoHttp({
  logger,
  // Skip health checks and CORS preflights (the browser sends one before many API calls).
  autoLogging: { ignore: (req) => req.url === '/health' || req.method === 'OPTIONS' },
  // req.log (used by the error handler) doesn't repeat the request details.
  quietReqLogger: true,
  serializers: {
    req: (req: IncomingMessage & { id?: unknown }) => ({ id: req.id, method: req.method, url: pathOf(req) }),
    res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
  },
  // 4xx are normal client mistakes (wrong password, no session), so only 5xx are errors.
  customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : 'info'),
  customSuccessMessage: (req, res, responseTime) =>
    `${req.method} ${pathOf(req)} ${res.statusCode} ${Math.round(responseTime)}ms`,
  customErrorMessage: (req, res, error) => `${req.method} ${pathOf(req)} ${res.statusCode} ${error.message}`,
});
