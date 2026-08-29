const { db } = require('../db');
const { sha256, canonical } = require('./crypto');

// Trail encadenado: cada entrada incluye el hash de la anterior → manipulación detectable

function append(actor, event, payload = {}) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const prevHash = last ? last.hash : 'GENESIS';
  const createdAt = new Date().toISOString();
  const hash = sha256(prevHash + actor + event + canonical(payload) + createdAt);
  db.prepare(
    'INSERT INTO audit_log (actor, event, payload_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(actor, event, JSON.stringify(payload), prevHash, hash, createdAt);
  return hash;
}

function trail(limit = 200) {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
}

function verifyChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, broken_at: r.id, reason: 'prev_hash no coincide' };
    const expected = sha256(r.prev_hash + r.actor + r.event + canonical(JSON.parse(r.payload_json)) + r.created_at);
    if (expected !== r.hash) return { ok: false, broken_at: r.id, reason: 'hash no coincide con el contenido' };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

module.exports = { append, trail, verifyChain };
