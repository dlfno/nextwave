const { db } = require('../db');
const audit = require('../lib/audit');
const { postJson } = require('../lib/rpc');
const { walletUrl } = require('../config');

// El merchant procesa un intento de compra: pide la verificación al Wallet (consulta en
// vivo, ahora por HTTP real — DECISIONS #33), persiste el resultado y lo audita.
async function processCheckout({ cart, agent_signature, actor = 'agent', agent_reasoning = null }) {
  let result;
  try {
    result = await postJson(`${walletUrl}/api/wallet/verify`, { cart, agent_signature });
  } catch (e) {
    // Autorizador inalcanzable ⇒ no se aprueba nada. Se registra igual, como rechazo.
    result = { status: 'rejected', reason: `verificación no disponible: ${e.message}`, checks: [{ name: 'consulta al Wallet', ok: false, detail: e.message }] };
  }

  // Un mandato inexistente no puede referenciarse (FK); el intento se registra sin él
  const mandateExists = cart.mandate_id != null && db.prepare('SELECT 1 FROM mandates WHERE id = ?').get(cart.mandate_id);
  const info = db
    .prepare(
      `INSERT INTO purchases (mandate_id, agent_id, product_id, description, amount, product_type,
         attributes_json, status, reason, checks_json, agent_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      mandateExists ? cart.mandate_id : null,
      cart.agent_id ?? null,
      cart.product_id ?? null,
      cart.description,
      cart.amount,
      cart.product_type,
      JSON.stringify(cart.attributes || {}),
      result.status,
      result.reason,
      JSON.stringify(result.checks),
      agent_reasoning
    );
  const purchaseId = info.lastInsertRowid;

  const evento = {
    purchase_id: purchaseId,
    mandate_id: cart.mandate_id,
    description: cart.description,
    amount: cart.amount,
    reason: result.reason,
  };

  if (result.status === 'approved') {
    // Captura del pago vía token; el merchant nunca ve la tarjeta
    db.prepare('UPDATE mandates SET spent = spent + ?, uses = uses + 1 WHERE id = ?').run(cart.amount, cart.mandate_id);
    audit.append('merchant', 'purchase_approved', evento);
  } else if (result.status === 'pending_approval') {
    audit.append('merchant', 'purchase_escalated_to_human', evento);
  } else {
    audit.append('merchant', 'purchase_rejected', { ...evento, actor_attempted: actor });
  }

  return { purchase_id: purchaseId, ...result };
}

module.exports = { processCheckout };
