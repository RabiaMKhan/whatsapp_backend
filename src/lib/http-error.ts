import { ERROR_CODES, type ErrorCode } from '@chat/shared';

/** An error with an HTTP status. The error handler turns it into `{ error: { code, message } }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, ERROR_CODES.VALIDATION_ERROR, message, details);

export const unauthorized = (message = 'Authentication required', code: ErrorCode = ERROR_CODES.UNAUTHORIZED) =>
  new HttpError(401, code, message);

export const forbidden = (message = 'You do not have access to this') =>
  new HttpError(403, ERROR_CODES.FORBIDDEN, message);

export const notFound = (message = 'Not found') => new HttpError(404, ERROR_CODES.NOT_FOUND, message);

export const conflict = (message: string, code: ErrorCode = ERROR_CODES.CONFLICT) =>
  new HttpError(409, code, message);

/** MongoDB duplicate key error (a unique index was violated). */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
