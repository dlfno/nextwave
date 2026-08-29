const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { generateKeyPair } = require('./lib/crypto');

const DB_PATH = path.join(__dirname, '..', 'database', 'nextwave.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'database', 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

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

function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

  const walletKeys = ensureKeys('wallet');
  const agentKeys = ensureKeys('agent-marta');
  const rogueKeys = ensureKeys('agent-rogue');
  void walletKeys;

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

  const insFlight = db.prepare(
    'INSERT INTO flights (origin, destination, airline, price, category, departs_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insFlight.run('Buenos Aires', 'Córdoba', 'AeroSur', 189, 'flights', '2026-09-10 08:30');
  insFlight.run('Buenos Aires', 'Córdoba', 'VuelaFlex', 210, 'flights', '2026-09-12 14:00');
  insFlight.run('Buenos Aires', 'Mendoza', 'AeroSur', 165, 'flights', '2026-09-11 09:15');
  insFlight.run('Buenos Aires', 'Bariloche', 'PataAir', 320, 'flights', '2026-09-15 07:45');
  insFlight.run('Buenos Aires', 'Salta', 'VuelaFlex', 145, 'flights', '2026-09-13 18:20');
}

seed();

module.exports = { db, ensureKeys };
