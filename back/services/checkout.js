const { db } = require('../db');
const { verifyPurchase } = require('./verify');
const audit = require('../lib/audit');

// El merchant procesa un intento de compra: verifica, persiste el resultado y lo audita.
function processCheckout({ cart, agent_signature, actor = 'agent', agent_reasoning = null }) {
  const result = verifyPurchase({ cart, agent_signature });

  // Un mandato inexistente no puede referenciarse (FK); el intento se registra sin él
  const mandateExists = cart.mandate_id != null && db.prepare('SELECT 1 FROM mandates WHERE id = ?').get(cart.mandate_id);
  const info = db
    .prepare(
      `INSERT INTO purchases (mandate_id, agent_id, flight_id, description, amount, category, status, reason, checks_json, agent_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      mandateExists ? cart.mandate_id : null,
      cart.agent_id ?? null,
      cart.flight_id ?? null,
      cart.description,
      cart.amount,
      cart.category,
      result.status,
      result.reason,
      JSON.stringify(result.checks),
      agent_reasoning
    );
  const purchaseId = info.lastInsertRowid;

  if (result.status === 'approved') {
    // Captura del pago vía token; el merchant nunca ve la tarjeta
    db.prepare('UPDATE mandates SET spent = spent + ?, uses = uses + 1 WHERE id = ?').run(cart.amount, cart.mandate_id);
    audit.append('merchant', 'purchase_approved', {
      purchase_id: purchaseId,
      mandate_id: cart.mandate_id,
      description: cart.description,
      amount: cart.amount,
      reason: result.reason,
    });
  } else if (result.status === 'pending_approval') {
    audit.append('merchant', 'purchase_escalated_to_human', {
      purchase_id: purchaseId,
      mandate_id: cart.mandate_id,
      description: cart.description,
      amount: cart.amount,
      reason: result.reason,
    });
  } else {
    audit.append('merchant', 'purchase_rejected', {
      purchase_id: purchaseId,
      mandate_id: cart.mandate_id,
      description: cart.description,
      amount: cart.amount,
      reason: result.reason,
      actor_attempted: actor,
    });
  }

  return { purchase_id: purchaseId, ...result };
}

module.exports = { processCheckout };
