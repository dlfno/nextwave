BEGIN;

INSERT INTO merchants (id, slug, name, status)
VALUES ('10000000-0000-4000-8000-000000000001', 'vuela-ya', 'VuelaYa', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  name = EXCLUDED.name,
  status = EXCLUDED.status;

INSERT INTO merchant_capabilities (
  id, merchant_id, capability, protocol, protocol_version, configuration
)
VALUES (
  '11000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'dev.ucp.shopping.checkout',
  'UCP',
  '2026-01-23',
  '{"mode":"mock","supportsAuthoritativeCheckout":true}'::jsonb
)
ON CONFLICT (merchant_id, capability, protocol, protocol_version) DO UPDATE SET
  configuration = EXCLUDED.configuration;

INSERT INTO products (id, canonical_name, category, description, attributes)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'Mexico City to Córdoba flight',
    'travel.flight',
    'Fictional one-way flight used by the VuelaYa hackathon demo.',
    '{"origin":"MEX","destination":"COR","passengers":1}'::jsonb
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
  )
ON CONFLICT (merchant_id, merchant_product_id) DO UPDATE SET
  product_id = EXCLUDED.product_id,
  unit_price_minor = EXCLUDED.unit_price_minor,
  currency = EXCLUDED.currency,
  availability = EXCLUDED.availability,
  attributes = EXCLUDED.attributes;

COMMIT;
