import { ERROR_CODES, type ApiErrorBody } from '@chat/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { HttpError, isDuplicateKeyError, notFound } from '../lib/http-error';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`Route ${req.method} ${req.path} not found`));
};

/** Express body-parser errors carry a `type` and an HTTP `status`. */
function bodyParserError(err: unknown): { status: number; message: string } | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null;
  if (err.type === 'entity.parse.failed') return { status: 400, message: 'Request body is not valid JSON' };
  if (err.type === 'entity.too.large') return { status: 413, message: 'Request body is too large' };
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const send = (status: number, error: ApiErrorBody['error']) => res.status(status).json({ error });

  if (err instanceof HttpError) {
    return send(err.status, {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    });
  }

  const parserError = bodyParserError(err);
  if (parserError) return send(parserError.status, { code: ERROR_CODES.VALIDATION_ERROR, message: parserError.message });

  if (err instanceof mongoose.Error.CastError) {
    return send(400, { code: ERROR_CODES.VALIDATION_ERROR, message: `Invalid value for ${err.path}` });
  }

  if (isDuplicateKeyError(err)) {
    return send(409, { code: ERROR_CODES.CONFLICT, message: 'This record already exists' });
  }

  // Unknown error: log the details, but never send stack traces to the client.
  (req.log ?? logger).error({ err }, 'Unhandled error');
  return send(500, { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong. Please try again.' });
};
