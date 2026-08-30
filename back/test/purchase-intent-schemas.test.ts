import { describe, expect, it } from 'vitest';

import { createPurchaseIntentSchema } from '../src/modules/purchase-intents/purchase-intent-schemas.js';

const intent = {
  agentId: '3f10de3a-6a1e-4c55-a75b-8f902b444da5',
  originalRequest: 'Buy a flight tomorrow.',
};

describe('purchase intent client context', () => {
  it('accepts bounded timezone and coarse-location context', () => {
    expect(createPurchaseIntentSchema.safeParse({
      ...intent,
      clientContext: {
        timeZone: 'America/Mexico_City',
        locale: 'es-MX',
        observedAt: '2026-08-29T04:00:00.000Z',
        location: { latitude: 19.43, longitude: -99.13, accuracyMeters: 1_500 },
      },
    }).success).toBe(true);
  });

  it('rejects invalid timezones and coordinates', () => {
    expect(createPurchaseIntentSchema.safeParse({
      ...intent,
      clientContext: {
        timeZone: 'not/a-timezone',
        locale: 'en-US',
        observedAt: '2026-08-29T04:00:00.000Z',
        location: { latitude: 190, longitude: -99.13, accuracyMeters: 1_500 },
      },
    }).success).toBe(false);
  });
});
