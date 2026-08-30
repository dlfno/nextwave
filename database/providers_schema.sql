drop database if exists providers;
create database providers encoding = 'UTF8' owner devuser;

\connect providers

ALTER SCHEMA public OWNER TO devuser;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO devuser;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO devuser;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO devuser;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT ALL PRIVILEGES ON TABLES TO devuser;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT ALL PRIVILEGES ON SEQUENCES TO devuser;

CREATE TABLE providers (
    id                    BIGSERIAL PRIMARY KEY,
    domain                TEXT        NOT NULL UNIQUE
                          CHECK (domain = lower(domain) AND domain NOT LIKE 'www.%'),
    name                  TEXT,
    homepage_url          TEXT        NOT NULL,

    platform              TEXT        NOT NULL DEFAULT 'unknown'
                          CHECK (platform IN ('shopify','woocommerce','vtex','magento',
                                              'prestashop','marketplace','custom','unknown')),
    status                TEXT        NOT NULL DEFAULT 'candidate'
                          CHECK (status IN ('candidate','verified','rejected')),

    -- Por qué creemos que esto es una tienda. Guardar las señales crudas
    -- permite reevaluar el umbral después sin volver a crawlear.
    detection_score       SMALLINT    NOT NULL DEFAULT 0,
    detection_signals     JSONB       NOT NULL DEFAULT '[]'::jsonb,

    -- Reputación. NULL significa "todavía no sabemos", que es honesto.
    -- reputation_source documenta de dónde salió el número: sin eso, un
    -- score es un dato sin trazabilidad y no debería usarse para decidir.
    reputation_score      REAL        CHECK (reputation_score BETWEEN 0 AND 100),
    reputation_source     TEXT,
    reputation_updated_at TIMESTAMPTZ,

    -- Cortesía de crawling, leída de robots.txt
    robots_allowed        BOOLEAN,
    crawl_delay_seconds   REAL        NOT NULL DEFAULT 1.0,

    discovered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at       TIMESTAMPTZ
);

CREATE INDEX providers_status_idx     ON providers (status);
CREATE INDEX providers_platform_idx   ON providers (platform);
CREATE INDEX providers_reputation_idx ON providers (reputation_score DESC NULLS LAST);


-- ---------------------------------------------------------------------
-- CATEGORÍAS — taxonomía cerrada y plana.
-- El crawler mapea el texto del sitio contra estos slugs; lo que no mapea
-- cae en 'other'. Plana porque una jerarquía sin caso de uso solo añade JOINs.
-- ---------------------------------------------------------------------
CREATE TABLE categories (
    slug  TEXT PRIMARY KEY,
    label TEXT NOT NULL
);

INSERT INTO categories (slug, label) VALUES
    ('electronics', 'Electrónica'),
    ('computers',   'Cómputo'),
    ('phones',      'Telefonía'),
    ('fashion',     'Ropa y accesorios'),
    ('shoes',       'Calzado'),
    ('home',        'Hogar y decoración'),
    ('furniture',   'Muebles'),
    ('kitchen',     'Cocina'),
    ('beauty',      'Belleza'),
    ('health',      'Salud'),
    ('sports',      'Deportes'),
    ('outdoors',    'Aire libre'),
    ('toys',        'Juguetes'),
    ('books',       'Libros'),
    ('groceries',   'Supermercado'),
    ('pets',        'Mascotas'),
    ('auto',        'Automotriz'),
    ('tools',       'Herramientas'),
    ('travel',      'Viajes'),
    ('other',       'Otros');


CREATE TABLE provider_categories (
    provider_id   BIGINT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    category_slug TEXT   NOT NULL REFERENCES categories (slug),
    confidence    REAL   NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    PRIMARY KEY (provider_id, category_slug)
);

CREATE INDEX provider_categories_cat_idx ON provider_categories (category_slug);


-- ---------------------------------------------------------------------
-- PAÍSES
--
-- has_presence = la tienda opera ahí (dominio local, moneda, sucursales)
-- ships_to     = declara enviar ahí
--
-- Están separados a propósito: una tienda con presencia en MX puede no
-- enviar a CL, y el agente necesita filtrar por "me lo puede entregar",
-- no por "existe en mi país".
-- ---------------------------------------------------------------------
CREATE TABLE provider_countries (
    provider_id  BIGINT  NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    country_code CHAR(2) NOT NULL CHECK (country_code = upper(country_code)),
    has_presence BOOLEAN NOT NULL DEFAULT FALSE,
    ships_to     BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (provider_id, country_code)
);

CREATE INDEX provider_countries_ships_idx
    ON provider_countries (country_code) WHERE ships_to;


-- ---------------------------------------------------------------------
-- PRODUCTOS — solo identidad, sin precio.
-- Único por (provider_id, url): la misma URL vista mil veces es un producto.
-- ---------------------------------------------------------------------
CREATE TABLE products (
    id            BIGSERIAL PRIMARY KEY,
    provider_id   BIGINT      NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    url           TEXT        NOT NULL,
    title         TEXT        NOT NULL,
    brand         TEXT,
    sku           TEXT,
    image_url     TEXT,
    category_slug TEXT        REFERENCES categories (slug),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider_id, url)
);

CREATE INDEX products_provider_idx ON products (provider_id);
CREATE INDEX products_category_idx ON products (category_slug);
CREATE INDEX products_title_idx    ON products (lower(title));
-- Para búsqueda por texto parcial rápida, cuando el volumen lo justifique:
--   CREATE EXTENSION pg_trgm;   -- requiere superusuario
--   CREATE INDEX products_title_trgm ON products USING gin (title gin_trgm_ops);


-- ---------------------------------------------------------------------
-- HISTORIAL DE PRECIOS — una fila por CAMBIO observado, no por scrape.
-- El insert condicional vive en server.py: si el precio es idéntico al
-- último, no se escribe nada. Así la tabla mide cambios, no actividad.
-- ---------------------------------------------------------------------
CREATE TABLE product_prices (
    id           BIGSERIAL PRIMARY KEY,
    product_id   BIGINT        NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    currency     CHAR(3)       NOT NULL CHECK (currency = upper(currency)),
    availability TEXT          NOT NULL DEFAULT 'unknown'
                 CHECK (availability IN ('in_stock','out_of_stock','preorder','unknown')),
    seen_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX product_prices_latest_idx ON product_prices (product_id, seen_at DESC);


-- Último precio conocido de cada producto. DISTINCT ON es la forma barata
-- en Postgres de hacer "primera fila por grupo".
CREATE VIEW product_latest_price AS
SELECT DISTINCT ON (product_id)
       product_id, price, currency, availability, seen_at
FROM   product_prices
ORDER  BY product_id, seen_at DESC;


-- ---------------------------------------------------------------------
-- EJECUCIONES — qué se pidió, cuándo terminó y con qué resultado.
-- Es lo que permite responder GET /runs/{id} sin mantener estado en RAM.
-- ---------------------------------------------------------------------
CREATE TABLE crawl_runs (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT        NOT NULL CHECK (kind IN ('discover','search','pipeline')),
    params        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','done','error')),
    stats         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);

CREATE INDEX crawl_runs_status_idx ON crawl_runs (status, started_at DESC);

-- ---------------------------------------------------------------------
-- Confirmación en pantalla de quién quedó como dueño.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Schema aplicado en "%" — dueño de las tablas: %',
        current_database(), current_user;
END
$$;

COMMIT;
