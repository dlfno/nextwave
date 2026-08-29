import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { HttpError } from '../shared/http-error.js';

export function validateBody(schema: ZodType): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      next(new HttpError(400, 'INVALID_REQUEST', 'Request body is invalid', result.error.issues));
      return;
    }

    request.body = result.data;
    next();
  };
}
