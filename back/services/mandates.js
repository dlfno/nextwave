const { db, ensureKeys } = require('../db');
const { sign } = require('../lib/crypto');
const audit = require('../lib/audit');

// Payload canónico del Intent Mandate: lo que el Wallet firma.
// Liga la llave pública del agente y el token de pago — la tarjeta cruda nunca aparece.
// Desde el modelo por producto también liga `evidence_hash`: el snapshot de scraping que
// justificó el mandato queda dentro de la firma, así el auditor puede replayear contra
// la misma evidencia que vio el titular al firmar.
function mandatePayload(row) {
  const agent = db.prepare('SELECT public_key FROM agents WHERE id = ?').get(row.agent_id);
  const pm = db.prepare('SELECT token FROM payment_methods WHERE id = ?').get(row.payment_method_id);
  return {
    mandate_id: row.id,
    user_id: row.user_id,
    agent_public_key: agent.public_key,
    payment_token: pm.token,
    product_type: row.product_type,
    spec: JSON.parse(row.spec_json || '[]'),
    max_amount: row.max_amount,
    total_budget: row.total_budget,
    max_uses_per_month: row.max_uses_per_month ?? null,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    evidence_hash: row.evidence_hash || null,
  };
}

function createMandate({
  user_id, agent_id, payment_method_id, ticket_id = null, product_type, spec = [],
  evidence_hash = null, max_amount, total_budget, max_uses_per_month = null,
  valid_from, valid_until, nl_text,
}) {
  const info = db
    .prepare(
      `INSERT INTO mandates (user_id, agent_id, payment_method_id, ticket_id, product_type, spec_json,
         evidence_hash, max_amount, total_budget, max_uses_per_month, valid_from, valid_until, wallet_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
    )
    .run(user_id, agent_id, payment_method_id, ticket_id, product_type, JSON.stringify(spec || []),
      evidence_hash, max_amount, total_budget, max_uses_per_month, valid_from, valid_until);

  const row = db.prepare('SELECT * FROM mandates WHERE id = ?').get(info.lastInsertRowid);
  const signature = sign(mandatePayload(row), ensureKeys('wallet').private_key);
  db.prepare('UPDATE mandates SET wallet_signature = ? WHERE id = ?').run(signature, row.id);
  row.wallet_signature = signature;

  audit.append('wallet', 'mandate_created', {
    mandate_id: row.id,
    ticket_id,
    product_type,
    spec,
    max_amount,
    total_budget,
    max_uses_per_month,
    valid_until,
    evidence_hash,
    // Lo que el titular dijo en sus palabras. Solo va al trail: añadirlo al payload firmado
    // (mandatePayload) invalidaría la verificación del merchant.
    ...(nl_text ? { nl_text: String(nl_text).slice(0, 500) } : {}),
  });
  return row;
}

// Re-firma un mandato tras cambiarle límites: sin esto la firma anterior queda inválida
// y el merchant rechazaría todo (DECISIONS #7).
function resignMandate(id) {
  const row = db.prepare('SELECT * FROM mandates WHERE id = ?').get(id);
  const signature = sign(mandatePayload(row), ensureKeys('wallet').private_key);
  db.prepare('UPDATE mandates SET wallet_signature = ? WHERE id = ?').run(signature, id);
  return signature;
}

module.exports = { mandatePayload, createMandate, resignMandate };
