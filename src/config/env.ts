import { z } from 'zod';

// Load apps/server/.env if it exists (Node's built-in loader, no dotenv needed).
// Tests set their own variables in vitest.config.ts, so skip the file there.
if (!process.env.VITEST) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: use the real environment (e.g. on a hosting platform).
  }
}

/** Empty strings in .env ("SMTP_HOST=") count as not set. */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value ? value : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  CLIENT_ORIGINS: z
    .string()
    .default('http://localhost:3005')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Email (nodemailer SMTP). Without SMTP_HOST, emails are printed to the
  // console in development instead of being sent.
  APP_URL: z.url().default('http://localhost:3005'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.stringbool().default(false), // true only for port 465
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  EMAIL_FROM: z.string().default('Relay <no-reply@relay.local>'),
}).refine((value) => value.NODE_ENV !== 'production' || Boolean(value.SMTP_HOST), {
  message: 'SMTP_HOST is required in production (verification emails must be sent)',
  path: ['SMTP_HOST'],
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
