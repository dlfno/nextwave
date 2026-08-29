import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../shared/http-error.js';

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, 'NOT_FOUND', 'Resource not found'));
};

export const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        correlationId: request.id,
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request is invalid',
        details: error.issues,
        correlationId: request.id,
      },
    });
    return;
  }

  request.log.error({ err: error }, 'Unhandled request error');
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      correlationId: request.id,
    },
  });
};
