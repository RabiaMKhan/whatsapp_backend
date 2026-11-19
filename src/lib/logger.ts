import { pino } from 'pino';
import { env, isProd, isTest } from '../config/env';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  // Never write tokens or cookies to the logs.
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  transport:
    isProd || isTest
      ? undefined
      : {
          target: 'pino-pretty',
          // Request details are already in the message (see request-logger.ts), so the
          // pretty dev output hides them. Production JSON logs keep every field.
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,req,res,responseTime,reqId',
          },
        },
});
