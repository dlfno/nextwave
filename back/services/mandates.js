const { db, ensureKeys } = require('../db');
const { sign } = require('../lib/crypto');
const audit = require('../lib/audit');

// Payload canónico del Intent Mandate: lo que el Wallet firma.
// Liga la llave pública del agente y el token de pago — la tarjeta cruda nunca aparece.
function mandatePayload(row) {
  const agent = db.prepare('SELECT public_key FROM agents WHERE id = ?').get(row.agent_id);
  const pm = db.prepare('SELECT token FROM payment_methods WHERE id = ?').get(row.payment_method_id);
  return {
    mandate_id: row.id,
    user_id: row.user_id,
    agent_public_key: agent.public_key,
    payment_token: pm.token,
    category: row.category,
    max_amount: row.max_amount,
    total_budget: row.total_budget,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    conditions: JSON.parse(row.conditions_json || '{}'),
  };
}

function createMandate({ user_id, agent_id, payment_method_id, category, max_amount, total_budget, valid_from, valid_until, conditions, nl_text }) {
  const info = db
    .prepare(
      `INSERT INTO mandates (user_id, agent_id, payment_method_id, category, max_amount, total_budget, valid_from, valid_until, conditions_json, wallet_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
    )
    .run(user_id, agent_id, payment_method_id, category, max_amount, total_budget, valid_from, valid_until, JSON.stringify(conditions || {}));

  const row = db.prepare('SELECT * FROM mandates WHERE id = ?').get(info.lastInsertRowid);
  const payload = mandatePayload(row);
  const walletKeys = ensureKeys('wallet');
  const signature = sign(payload, walletKeys.private_key);
  db.prepare('UPDATE mandates SET wallet_signature = ? WHERE id = ?').run(signature, row.id);
  row.wallet_signature = signature;

  audit.append('wallet', 'mandate_created', {
    mandate_id: row.id,
    category,
    max_amount,
    total_budget,
    valid_until,
    conditions: conditions || {},
    // Lo que Marta dijo en sus palabras. Solo va al trail: añadirlo al payload firmado
    // (mandatePayload) invalidaría la verificación del merchant.
    ...(nl_text ? { nl_text: String(nl_text).slice(0, 500) } : {}),
  });
  return row;
}

module.exports = { mandatePayload, createMandate };
