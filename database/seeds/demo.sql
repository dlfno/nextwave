BEGIN;

INSERT INTO merchants (id, slug, name, status)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'vuela-ya', 'VuelaYa', 'ACTIVE'),
  ('10000000-0000-4000-8000-000000000002', 'aerosur', 'AeroSur', 'ACTIVE'),
  ('10000000-0000-4000-8000-000000000003', 'nubevia', 'NubeVia', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  name = EXCLUDED.name,
  status = EXCLUDED.status;

INSERT INTO merchant_capabilities (
  id, merchant_id, capability, protocol, protocol_version, configuration
)
VALUES
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'dev.ucp.shopping.checkout', 'UCP', '2026-04-08', '{"mode":"mock","supportsAuthoritativeCheckout":true}'::jsonb),
  ('11000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'merchant.flight.search', 'REST', '1', '{"mode":"mock","supportsAuthoritativeCheckout":true}'::jsonb),
  ('11000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'dev.ucp.shopping.checkout', 'UCP', '2026-04-08', '{"mode":"http","supportsAuthoritativeCheckout":true,"ap2Mandates":true}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  merchant_id = EXCLUDED.merchant_id,
  capability = EXCLUDED.capability,
  protocol = EXCLUDED.protocol,
  protocol_version = EXCLUDED.protocol_version,
  configuration = EXCLUDED.configuration;

INSERT INTO products (id, canonical_name, category, description, attributes)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'Mexico City to Córdoba flight',
    'travel.flight',
    'Fictional one-way flight used by the VuelaYa hackathon demo.',
    '{"origin":"MEX","destination":"COR","passengers":1,"departureDate":"2026-09-15"}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'AeroSur Mexico City to Córdoba flight',
    'travel.flight',
    'Fictional merchant API offer with authoritative price refresh.',
    '{"origin":"MEX","destination":"COR","passengers":1,"departureDate":"2026-09-15"}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    'NubeVia Mexico City to Córdoba flight',
    'travel.flight',
    'Fictional UCP offer used for protocol comparison.',
    '{"origin":"MEX","destination":"COR","passengers":1,"departureDate":"2026-09-15"}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Mexico City to Córdoba premium flight',
    'travel.flight',
    'Fictional over-limit flight used to demonstrate deterministic denial.',
    '{"origin":"MEX","destination":"COR","passengers":1}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  canonical_name = EXCLUDED.canonical_name,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  attributes = EXCLUDED.attributes;

INSERT INTO merchant_catalog_items (
  id, merchant_id, product_id, merchant_product_id,
  unit_price_minor, currency, availability, attributes
)
VALUES
  (
    '21000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'VY-MEX-COR-130', 13000, 'USD', 'IN_STOCK',
    '{"departureTime":"2026-09-15T14:00:00Z","fareClass":"ECONOMY"}'::jsonb
  ),
  (
    '21000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'VY-MEX-COR-300', 30000, 'USD', 'IN_STOCK',
    '{"departureTime":"2026-09-15T16:00:00Z","fareClass":"PREMIUM"}'::jsonb
  ),
  (
    '21000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    'AS-MEX-COR-118', 11800, 'USD', 'IN_STOCK',
    '{"departureTime":"2026-09-15T15:20:00Z","fareClass":"LIGHT_ECONOMY"}'::jsonb
  ),
  (
    '21000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    'NV-MEX-COR-145', 14500, 'USD', 'IN_STOCK',
    '{"departureTime":"2026-09-15T12:45:00Z","fareClass":"FLEX_ECONOMY"}'::jsonb
  )
ON CONFLICT (merchant_id, merchant_product_id) DO UPDATE SET
  product_id = EXCLUDED.product_id,
  unit_price_minor = EXCLUDED.unit_price_minor,
  currency = EXCLUDED.currency,
  availability = EXCLUDED.availability,
  attributes = EXCLUDED.attributes;

COMMIT;
