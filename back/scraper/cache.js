const { db } = require('../db');
const { sha256 } = require('../lib/crypto');

// Caché del scraping en SQLite. No es para ahorrar red: es para que el ticket que el
// usuario está revisando (y que el front polea cada 2s) no dispare una salida a internet
// por poll, y para que el snapshot que se firma sea el mismo que se investigó.

const TTL_MS = Number(process.env.SCRAPE_TTL_MS || 15 * 60 * 1000);

function key(...partes) {
  return sha256(partes.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|'));
}

function get(k, ttl = TTL_MS) {
  const row = db.prepare('SELECT * FROM scrape_cache WHERE key = ?').get(k);
  if (!row) return null;
  if (Date.now() - new Date(row.fetched_at + 'Z').getTime() > ttl) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

function set(k, payload) {
  db.prepare(
    `INSERT INTO scrape_cache (key, payload_json, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`
  ).run(k, JSON.stringify(payload));
  return payload;
}

// Envuelve una función asíncrona con caché por TTL.
async function through(k, fn, ttl = TTL_MS) {
  const hit = get(k, ttl);
  if (hit) return { ...hit, cached: true };
  const fresh = await fn();
  set(k, fresh);
  return { ...fresh, cached: false };
}

module.exports = { key, get, set, through, TTL_MS };
