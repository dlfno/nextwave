-- Pagos agénticos: schema SQLite

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

-- Intent Mandate (nomenclatura AP2): lo que el humano autoriza al agente
CREATE TABLE IF NOT EXISTS mandates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  category TEXT NOT NULL,            -- p.ej. 'flights'
  max_amount REAL NOT NULL,          -- máximo por compra
  total_budget REAL NOT NULL,        -- presupuesto total del mandato
  spent REAL NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '{}',  -- price_below, max_uses_per_month, destination...
  uses INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',       -- active | revoked | expired
  revoked_at TEXT,
  wallet_signature TEXT NOT NULL,    -- firma del Wallet sobre el payload canónico del mandato
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  airline TEXT NOT NULL,
  price REAL NOT NULL,
  category TEXT NOT NULL DEFAULT 'flights',
  departs_at TEXT NOT NULL
);

-- Cart Mandate (AP2): cada intento de compra concreto del agente
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id INTEGER REFERENCES mandates(id),
  agent_id INTEGER REFERENCES agents(id),
  flight_id INTEGER REFERENCES flights(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL,
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
