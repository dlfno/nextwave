import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '../../database/client.js';
import { agents } from '../../database/schema.js';
import { validateBody } from '../../http/validate.js';
import { HttpError } from '../../shared/http-error.js';
import { authenticate, requireCsrf } from '../auth/session.js';
import { createAgentSchema } from './agent-schemas.js';

const agentIdSchema = z.uuid();

export function createAgentRouter(database: DatabaseClient): Router {
  const router = Router();
  const requireAuthentication = authenticate(database);

  router.use(requireAuthentication);

  router.get('/', async (request, response) => {
    const records = await database.db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        currentKeyId: agents.currentKeyId,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(eq(agents.ownerUserId, request.auth!.user.id))
      .orderBy(desc(agents.createdAt));
    response.json({ agents: records });
  });

  router.post('/', requireCsrf, validateBody(createAgentSchema), async (request, response) => {
    const [record] = await database.db
      .insert(agents)
      .values({ ownerUserId: request.auth!.user.id, name: request.body.name })
      .returning({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        currentKeyId: agents.currentKeyId,
        createdAt: agents.createdAt,
      });
    response.status(201).json({ agent: record });
  });

  router.get('/:agentId', async (request, response) => {
    const parsedId = agentIdSchema.safeParse(request.params.agentId);
    if (!parsedId.success) {
      throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    }

    const [record] = await database.db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        currentKeyId: agents.currentKeyId,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(and(eq(agents.id, parsedId.data), eq(agents.ownerUserId, request.auth!.user.id)))
      .limit(1);

    if (!record) {
      throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    }

    response.json({ agent: record });
  });

  return router;
}
