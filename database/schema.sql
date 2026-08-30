-- Pagos agénticos: schema SQLite
-- El mandato dejó de ser "vuelos con campos fijos": ahora es un tipo de producto más una
-- lista de restricciones tipadas (spec_json) que un motor genérico evalúa. Cada request del
-- usuario nace como un ticket con la evidencia real de scraping congelada (DECISIONS #23).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,        -- token opaco; la tarjeta cruda nunca se guarda ni viaja
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,          -- Ed25519, PEM
  is_rogue INTEGER NOT NULL DEFAULT 0
);

-- Ticket de mandato: una fila por petición en lenguaje natural del usuario.
-- Guarda todo el camino investigación → razonabilidad → borrador editable → firma.
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  request_text TEXT NOT NULL,
  product_type TEXT,                            -- flights | groceries | generic...
  status TEXT NOT NULL DEFAULT 'researching',   -- researching | needs_review | ready | signed | discarded | failed
  intent_json TEXT NOT NULL DEFAULT '{}',       -- lo que el LLM entendió de la petición
  evidence_json TEXT NOT NULL DEFAULT '{}',     -- snapshot del scraping: fuentes, muestras, estadísticas
  evidence_hash TEXT,                           -- sha256 del snapshot: lo que firma el mandato
  feasibility_json TEXT NOT NULL DEFAULT '{}',  -- veredicto de razonabilidad + recomendaciones
  draft_json TEXT NOT NULL DEFAULT '{}',        -- las variables editables que ve el usuario
  chat_json TEXT NOT NULL DEFAULT '[]',         -- conversación sobre el ticket
  mandate_id INTEGER REFERENCES mandates(id),   -- se llena al firmar
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Intent Mandate (nomenclatura AP2): lo que el humano autoriza al agente
CREATE TABLE IF NOT EXISTS mandates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  ticket_id INTEGER REFERENCES tickets(id),
  product_type TEXT NOT NULL,        -- p.ej. 'flights', 'groceries'
  spec_json TEXT NOT NULL DEFAULT '[]',  -- [{attr, op, value}] evaluado por lib/spec.js
  evidence_hash TEXT,                -- ata el mandato a la evidencia que lo justificó
  max_amount REAL NOT NULL,          -- máximo por compra
  total_budget REAL NOT NULL,        -- presupuesto total del mandato
  spent REAL NOT NULL DEFAULT 0,
  max_uses_per_month INTEGER,        -- null = sin tope de frecuencia
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',       -- active | revoked | expired
  revoked_at TEXT,
  wallet_signature TEXT NOT NULL,    -- firma del Wallet sobre el payload canónico del mandato
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catálogo del merchant, ya genérico: un vuelo y un paquete de café son la misma fila
-- con distinto product_type y distintos attributes_json.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type TEXT NOT NULL,
  merchant TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  attributes_json TEXT NOT NULL DEFAULT '{}',   -- marca, aerolínea, gramaje, talla, destino...
  source TEXT NOT NULL DEFAULT 'seed',          -- adaptador que lo trajo
  source_url TEXT,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Caché del scraping real: evita re-salir a internet en cada poll y deja el snapshot
-- reproducible para el auditor.
CREATE TABLE IF NOT EXISTS scrape_cache (
  key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cart Mandate (AP2): cada intento de compra concreto del agente
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id INTEGER REFERENCES mandates(id),
  agent_id INTEGER REFERENCES agents(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  product_type TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',   -- atributos del ítem comprado, verificables
  status TEXT NOT NULL,              -- approved | rejected | pending_approval | denied
  reason TEXT NOT NULL,              -- motivo legible del resultado
  checks_json TEXT NOT NULL DEFAULT '[]',  -- resultado de cada check de verificación
  agent_reasoning TEXT,              -- explicación del agente (LLM o plantilla)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  claim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  verdict TEXT,                          -- responsable: user | agent | merchant
  verdict_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Trail auditable encadenado por hash
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,               -- human | agent | rogue-agent | merchant | wallet | auditor
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
