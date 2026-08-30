import { and, asc, desc, eq } from 'drizzle-orm';

import type { DatabaseClient } from '../../database/client.js';
import { AuditService } from '../audit/audit-service.js';
import { agents, intentMessages, purchaseIntents } from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { purchaseClientContextSchema, type CreatePurchaseIntentInput, type PurchaseClientContext } from './purchase-intent-schemas.js';
import type { ConversationMessage, PurchasingAgentProvider } from './purchasing-agent-provider.js';
import { specificationsSchema } from './specifications.js';

export class PurchaseIntentService {
  private readonly audit: AuditService;

  constructor(
    private readonly database: DatabaseClient,
    private readonly agentProvider: PurchasingAgentProvider,
  ) {
    this.audit = new AuditService(database);
  }

  async create(userId: string, input: CreatePurchaseIntentInput) {
    const [ownedAgent] = await this.database.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.ownerUserId, userId), eq(agents.status, 'ACTIVE')))
      .limit(1);

    if (!ownedAgent) throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');

    const initialMessage: ConversationMessage = { role: 'USER', content: input.originalRequest };
    const clarification = await this.agentProvider.analyze([initialMessage], input.clientContext);
    const status = clarification.ready ? 'READY_FOR_MANDATE' : 'CLARIFYING';

    const result = await this.database.db.transaction(async (transaction) => {
      const [intent] = await transaction
        .insert(purchaseIntents)
        .values({
          userId,
          agentId: input.agentId,
          originalRequest: input.originalRequest,
          clientContext: input.clientContext,
          status,
        })
        .returning();
      if (!intent) throw new Error('Purchase intent insert did not return a row');

      const [userMessage, agentMessage] = await transaction
        .insert(intentMessages)
        .values([
          { intentId: intent.id, role: 'USER', content: input.originalRequest },
          {
            intentId: intent.id,
            role: 'AGENT',
            content: clarification.message,
            structuredPayload: { type: 'CLARIFICATION', missingFields: clarification.missingFields },
          },
        ])
        .returning();

      return { intent, messages: [userMessage, agentMessage] };
    });
    await this.audit.append({
      eventType: 'PURCHASE_INTENT_CREATED', actorType: 'USER', actorId: userId,
      intentId: result.intent.id,
      payload: { originalRequest: input.originalRequest, agentId: input.agentId, status },
    });
    return result;
  }

  async list(userId: string) {
    return this.database.db
      .select({
        id: purchaseIntents.id,
        agentId: purchaseIntents.agentId,
        status: purchaseIntents.status,
        originalRequest: purchaseIntents.originalRequest,
        createdAt: purchaseIntents.createdAt,
        updatedAt: purchaseIntents.updatedAt,
      })
      .from(purchaseIntents)
      .where(eq(purchaseIntents.userId, userId))
      .orderBy(desc(purchaseIntents.createdAt));
  }

  async get(userId: string, intentId: string) {
    const intent = await this.findOwned(userId, intentId);
    const messages = await this.database.db
      .select()
      .from(intentMessages)
      .where(eq(intentMessages.intentId, intentId))
      .orderBy(asc(intentMessages.createdAt), asc(intentMessages.id));
    return { intent, messages };
  }

  async addMessage(userId: string, intentId: string, content: string) {
    const intent = await this.findOwned(userId, intentId);
    if (intent.searchSpecification || intent.authorizationSpecification) {
      throw new HttpError(409, 'INTENT_ALREADY_FINALIZED', 'Specifications are already finalized');
    }

    const priorMessages = await this.providerMessages(intentId);
    const userMessage: ConversationMessage = { role: 'USER', content };
    const context = this.context(intent.clientContext);
    const clarification = await this.agentProvider.analyze([...priorMessages, userMessage], context);
    const status = clarification.ready ? 'READY_FOR_MANDATE' : 'CLARIFYING';

    const result = await this.database.db.transaction(async (transaction) => {
      const [storedUserMessage, storedAgentMessage] = await transaction
        .insert(intentMessages)
        .values([
          { intentId, role: 'USER', content },
          {
            intentId,
            role: 'AGENT',
            content: clarification.message,
            structuredPayload: { type: 'CLARIFICATION', missingFields: clarification.missingFields },
          },
        ])
        .returning();
      await transaction.update(purchaseIntents).set({ status }).where(eq(purchaseIntents.id, intentId));

      return {
        status,
        ready: clarification.ready,
        messages: [storedUserMessage, storedAgentMessage],
      };
    });
    await this.audit.append({
      eventType: 'INTENT_CLARIFIED', actorType: 'USER', actorId: userId, intentId,
      payload: { status, ready: clarification.ready, missingFields: clarification.missingFields },
    });
    return result;
  }

  async finalize(userId: string, intentId: string) {
    const intent = await this.findOwned(userId, intentId);
    if (intent.searchSpecification && intent.authorizationSpecification) {
      return {
        searchSpecification: intent.searchSpecification,
        authorizationSpecification: intent.authorizationSpecification,
      };
    }

    const messages = await this.providerMessages(intentId);
    const context = this.context(intent.clientContext);
    const clarification = await this.agentProvider.analyze(messages, context);
    if (!clarification.ready) {
      throw new HttpError(409, 'CLARIFICATION_REQUIRED', 'More information is required', {
        missingFields: clarification.missingFields,
      });
    }

    let specifications: ReturnType<typeof specificationsSchema.parse>;
    try {
      specifications = specificationsSchema.parse(await this.agentProvider.buildSpecifications(messages, context));
    } catch {
      throw new HttpError(502, 'AGENT_OUTPUT_INVALID', 'The agent returned invalid specifications');
    }

    const [updated] = await this.database.db
      .update(purchaseIntents)
      .set({
        status: 'READY_FOR_MANDATE',
        searchSpecification: specifications.searchSpecification,
        authorizationSpecification: specifications.authorizationSpecification,
      })
      .where(and(eq(purchaseIntents.id, intentId), eq(purchaseIntents.userId, userId)))
      .returning();

    if (!updated) throw new HttpError(404, 'PURCHASE_INTENT_NOT_FOUND', 'Purchase intent not found');
    await this.audit.append({
      eventType: 'SPECIFICATIONS_FINALIZED', actorType: 'AGENT', actorId: intent.agentId, intentId,
      payload: { searchSpecification: specifications.searchSpecification, authorizationSpecification: specifications.authorizationSpecification },
    });
    return specifications;
  }

  private async findOwned(userId: string, intentId: string) {
    const [intent] = await this.database.db
      .select()
      .from(purchaseIntents)
      .where(and(eq(purchaseIntents.id, intentId), eq(purchaseIntents.userId, userId)))
      .limit(1);
    if (!intent) throw new HttpError(404, 'PURCHASE_INTENT_NOT_FOUND', 'Purchase intent not found');
    return intent;
  }

  private async providerMessages(intentId: string): Promise<ConversationMessage[]> {
    const messages = await this.database.db
      .select({ role: intentMessages.role, content: intentMessages.content })
      .from(intentMessages)
      .where(eq(intentMessages.intentId, intentId))
      .orderBy(asc(intentMessages.createdAt), asc(intentMessages.id));

    return messages.filter(
      (message): message is ConversationMessage => message.role === 'USER' || message.role === 'AGENT',
    );
  }

  private context(value: unknown): PurchaseClientContext | undefined {
    const parsed = purchaseClientContextSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
}
