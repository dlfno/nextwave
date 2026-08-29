import type { RequestHandler } from 'express';

import { HttpError } from '../shared/http-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireAllowedOrigin(frontendOrigin: string): RequestHandler {
  return (request, _response, next) => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    if (request.get('origin') !== frontendOrigin) {
      next(new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed'));
      return;
    }

    next();
  };
}
