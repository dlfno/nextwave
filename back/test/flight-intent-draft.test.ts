import { describe, expect, it } from 'vitest';

import {
  compileSpecifications,
  hashIntentDraft,
  validateDraftSources,
  type FlightIntentDraft,
} from '../src/modules/purchase-intents/flight-intent-draft.js';

const draft: FlightIntentDraft = {
  origin: { city: 'Los Angeles', iata: 'LAX' },
  destination: { city: 'Córdoba', country: 'Spain', iata: 'ODB' },
  departureDate: '2026-09-02',
  passengers: 2,
  maxTotalMinor: '200000',
  currency: 'MXN',
  validUntil: '2026-09-03T05:59:59Z',
  requiresFinalConfirmation: true,
  sources: {
    origin: 0, destination: 0, departureDate: 0, passengers: 0,
    maxTotalMinor: 0, currency: 0, validUntil: 0, requiresFinalConfirmation: 0,
  },
};

describe('canonical flight intent compiler', () => {
  it('preserves reviewed facts exactly and binds the specification to its hash', () => {
    const compiled = compileSpecifications(draft);
    expect(compiled.authorizationSpecification).toMatchObject({
      intentDraftHash: hashIntentDraft(draft),
      productConstraints: {
        originIata: 'LAX', destinationIata: 'ODB', departureDate: '2026-09-02', quantity: 2,
      },
      spendConstraints: { maxTotalMinor: '200000', currency: 'MXN' },
    });
  });

  it('rejects a fact attributed to an assistant response', () => {
    expect(() => validateDraftSources(draft, [{ role: 'AGENT', content: 'I invented these details.' }]))
      .toThrow('not backed by a user message');
  });

  it('rejects unknown airport codes before mandate compilation', () => {
    expect(() => validateDraftSources({ ...draft, origin: { city: 'Imaginary', iata: 'ZZZ' } }, [
      { role: 'USER', content: 'Fly from ZZZ.' },
    ])).toThrow('Unknown origin airport');
  });
});
