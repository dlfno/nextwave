const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { generateKeyPair } = require('./lib/crypto');

const DB_PATH = path.join(__dirname, '..', 'database', 'nextwave.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'database', 'schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

const db = new Database(DB_PATH);
// Los 3 servicios (wallet/merchant/agent) abren este mismo archivo. busy_timeout va PRIMERO
// para que hasta el cambio a WAL y el CREATE TABLE inicial esperen el lock en vez de tirar
// SQLITE_BUSY cuando arrancan a la vez (DECISIONS #33).
db.pragma('busy_timeout = 10000');
db.pragma('journal_mode = WAL');
db.exec(SCHEMA_SQL);

// Llaves privadas (Wallet y agentes corren server-side; en producción vivirían en HSM/enclave)
db.exec(`CREATE TABLE IF NOT EXISTS keys (
  name TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL
)`);

function ensureKeys(name) {
  let row = db.prepare('SELECT * FROM keys WHERE name = ?').get(name);
  if (!row) {
    const kp = generateKeyPair();
    db.prepare('INSERT INTO keys (name, public_key, private_key) VALUES (?, ?, ?)').run(
      name, kp.publicKey, kp.privateKey
    );
    row = { name, public_key: kp.publicKey, private_key: kp.privateKey };
  }
  return row;
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columns(table) {
  if (!tableExists(table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Migración del modelo estático (category + conditions_json + tabla flights) al modelo
// por producto con spec tipada. Se conservan los datos: la tabla vieja se renombra, el
// schema recrea la nueva y se copian las filas mapeadas.
// legacy_alter_table = ON es imprescindible: sin él, SQLite reescribe las referencias de
// LAS DEMÁS tablas al renombrar (tickets.mandate_id pasaba a apuntar a mandates_legacy y
// la tabla quedaba rota en cuanto se borraba la vieja).
function rebuild(table, copy) {
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
    db.exec(SCHEMA_SQL); // recrea solo la tabla que acabamos de mover
    copy();
    db.exec(`DROP TABLE ${table}_legacy`);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
}

// Repara bases migradas con la versión anterior de rebuild(), que dejó tablas apuntando a
// un `*_legacy` inexistente. Se conservan las filas: solo se rehace la definición.
function repararReferencias() {
  const rotas = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%_legacy%' AND name NOT LIKE '%_legacy'")
    .all()
    .map((r) => r.name);
  for (const t of rotas) {
    const filas = db.prepare(`SELECT * FROM ${t}`).all();
    db.exec(`DROP TABLE ${t}`);
    db.exec(SCHEMA_SQL);
    if (!filas.length) continue;
    const cols = Object.keys(filas[0]);
    const ins = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
    for (const f of filas) ins.run(f);
  }
}

function migrate() {
  const mandateCols = columns('mandates');
  const legacyMandates = mandateCols.length && !mandateCols.includes('product_type');

  if (legacyMandates) {
    rebuild('mandates', () => {
      const rows = db.prepare('SELECT * FROM mandates_legacy').all();
      const ins = db.prepare(
        `INSERT INTO mandates (id, user_id, agent_id, payment_method_id, product_type, spec_json,
           max_amount, total_budget, spent, max_uses_per_month, valid_from, valid_until, uses,
           status, revoked_at, wallet_signature, created_at)
         VALUES (@id, @user_id, @agent_id, @payment_method_id, @product_type, @spec_json,
           @max_amount, @total_budget, @spent, @max_uses_per_month, @valid_from, @valid_until,
           @uses, @status, @revoked_at, @wallet_signature, @created_at)`
      );
      for (const r of rows) {
        const cond = JSON.parse(r.conditions_json || '{}');
        const spec = [];
        if (cond.destination) spec.push({ attr: 'destination', op: 'eq', value: cond.destination });
        if (cond.price_below != null) spec.push({ attr: 'price', op: 'lt', value: Number(cond.price_below) });
        ins.run({
          ...r,
          product_type: r.category || 'flights',
          spec_json: JSON.stringify(spec),
          max_uses_per_month: cond.max_uses_per_month != null ? Number(cond.max_uses_per_month) : null,
        });
      }
    });
  }

  if (tableExists('flights')) {
    const ins = db.prepare(
      `INSERT INTO products (id, product_type, merchant, title, price, currency, attributes_json, source, scraped_at)
       VALUES (?, 'flights', 'VuelaYa', ?, ?, 'USD', ?, 'seed', ?)`
    );
    for (const f of db.prepare('SELECT * FROM flights').all()) {
      if (db.prepare('SELECT 1 FROM products WHERE id = ?').get(f.id)) continue;
      ins.run(
        f.id,
        `Vuelo ${f.origin} → ${f.destination} (${f.airline})`,
        f.price,
        JSON.stringify({ origin: f.origin, destination: f.destination, airline: f.airline, departs_at: f.departs_at }),
        f.departs_at
      );
    }
    // purchases.flight_id apunta a flights: se reconstruye antes de tirar la tabla
    const purchaseCols = columns('purchases');
    if (purchaseCols.includes('flight_id')) {
      rebuild('purchases', () => {
        db.exec(
          `INSERT INTO purchases (id, mandate_id, agent_id, product_id, description, amount,
             product_type, attributes_json, status, reason, checks_json, agent_reasoning, created_at, resolved_at)
           SELECT id, mandate_id, agent_id, flight_id, description, amount,
             category, '{}', status, reason, checks_json, agent_reasoning, created_at, resolved_at
           FROM purchases_legacy`
        );
      });
    }
    db.exec('DROP TABLE flights');
  }

  // Cambiar la forma del payload firmado invalida las firmas viejas: el Wallet re-firma
  // los mandatos migrados (mismo criterio que PATCH /mandates/:id, DECISIONS #7).
  if (legacyMandates) {
    const { mandatePayload } = require('./services/mandates');
    const { sign } = require('./lib/crypto');
    const key = ensureKeys('wallet').private_key;
    for (const m of db.prepare('SELECT * FROM mandates').all()) {
      db.prepare('UPDATE mandates SET wallet_signature = ? WHERE id = ?').run(sign(mandatePayload(m), key), m.id);
    }
  }
}

// Catálogo semilla de VuelaYa: el merchant local con el que corre la demo aunque no haya
// red. El scraping real añade productos de fuentes externas junto a estos.
const SEED_PRODUCTS = [
  ['Buenos Aires', 'Córdoba', 'AeroSur', 189, '2026-09-10 08:30'],
  ['Buenos Aires', 'Córdoba', 'VuelaFlex', 210, '2026-09-12 14:00'],
  ['Buenos Aires', 'Mendoza', 'AeroSur', 165, '2026-09-11 09:15'],
  ['Buenos Aires', 'Bariloche', 'PataAir', 320, '2026-09-15 07:45'],
  ['Buenos Aires', 'Salta', 'VuelaFlex', 145, '2026-09-13 18:20'],
];

function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

  ensureKeys('wallet');
  const agentKeys = ensureKeys('agent-marta');
  const rogueKeys = ensureKeys('agent-rogue');

  const marta = db.prepare("INSERT INTO users (name, email) VALUES ('Marta', 'marta@example.com')").run();

  db.prepare('INSERT INTO payment_methods (user_id, token, brand, last4) VALUES (?, ?, ?, ?)').run(
    marta.lastInsertRowid, 'tok_' + Math.random().toString(36).slice(2, 12), 'Visa', '4242'
  );

  db.prepare('INSERT INTO agents (user_id, name, public_key, is_rogue) VALUES (?, ?, ?, 0)').run(
    marta.lastInsertRowid, 'Asistente de Marta', agentKeys.public_key
  );
  db.prepare('INSERT INTO agents (user_id, name, public_key, is_rogue) VALUES (?, ?, ?, 1)').run(
    marta.lastInsertRowid, 'Agente Rogue', rogueKeys.public_key
  );

  const ins = db.prepare(
    `INSERT INTO products (product_type, merchant, title, price, currency, attributes_json, source, scraped_at)
     VALUES ('flights', 'VuelaYa', ?, ?, 'USD', ?, 'seed', ?)`
  );
  for (const [origin, destination, airline, price, departs_at] of SEED_PRODUCTS) {
    ins.run(
      `Vuelo ${origin} → ${destination} (${airline})`,
      price,
      JSON.stringify({ origin, destination, airline, departs_at }),
      departs_at
    );
  }
}

// Se exporta antes de migrar: la migración re-firma mandatos vía services/mandates, que
// a su vez requiere este módulo. Sin esto el ciclo de requires se resuelve a medias.
module.exports = { db, ensureKeys };

migrate();
repararReferencias();
seed();
