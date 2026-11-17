import type { z } from 'zod';
import { badRequest } from './http-error';

/**
 * Validate input with a Zod schema. Throws a 400 HttpError with the first
 * issue as the message and every issue in `details`.
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  throw badRequest(result.error.issues[0]?.message ?? 'Invalid input', details);
}
