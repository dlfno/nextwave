const { db, ensureKeys } = require('../db');
const { verify } = require('../lib/crypto');
const { mandatePayload } = require('./mandates');
const conditions = require('../lib/conditions');

// Verificación completa del merchant antes de aceptar una compra agéntica.
// Devuelve { status: 'approved' | 'rejected' | 'pending_approval', reason, checks }.
// Regla de oro: nada se aprueba en silencio — cada check queda registrado.

function verifyPurchase({ cart, agent_signature }) {
  const checks = [];
  const fail = (reason) => ({ status: 'rejected', reason, checks });

  const mandate = db.prepare('SELECT * FROM mandates WHERE id = ?').get(cart.mandate_id);
  checks.push({ name: 'mandato existe', ok: !!mandate, detail: `mandate_id ${cart.mandate_id}` });
  if (!mandate) return fail('el mandato referido no existe');

  // 1. Firma del Wallet sobre el mandato → el mandato es legítimo, no inventado
  const payload = mandatePayload(mandate);
  const walletKeys = ensureKeys('wallet');
  const walletOk = verify(payload, mandate.wallet_signature, walletKeys.public_key);
  checks.push({ name: 'firma del Wallet sobre el mandato', ok: walletOk, detail: 'Ed25519' });
  if (!walletOk) return fail('firma del Wallet inválida: mandato adulterado o falsificado');

  // 2. Firma del agente sobre el carrito, contra la llave ligada al mandato → anti-impersonación
  const agentOk = verify(cart, agent_signature, payload.agent_public_key);
  checks.push({ name: 'firma del agente sobre el carrito', ok: agentOk, detail: 'llave ligada al mandato' });
  if (!agentOk) return fail('firma del agente inválida: posible impersonación');

  // 3. Estado en vivo del mandato (consulta al Wallet): revocación y vigencia
  const notRevoked = mandate.status === 'active';
  checks.push({
    name: 'mandato no revocado (consulta en vivo al Wallet)',
    ok: notRevoked,
    detail: `estado: ${mandate.status}`,
  });
  if (!notRevoked) return fail(`mandato ${mandate.status === 'revoked' ? 'revocado por el titular' : mandate.status}`);

  const now = new Date().toISOString();
  const inWindow = now >= new Date(mandate.valid_from).toISOString() && now <= new Date(mandate.valid_until).toISOString();
  checks.push({ name: 'mandato vigente', ok: inWindow, detail: `válido hasta ${mandate.valid_until}` });
  if (!inWindow) return fail('mandato expirado o aún no vigente');

  // 4. Categoría
  const catOk = cart.category === mandate.category;
  checks.push({ name: `categoría permitida (${mandate.category})`, ok: catOk, detail: `compra: ${cart.category}` });
  if (!catOk) return fail(`categoría "${cart.category}" fuera del mandato (permite: ${mandate.category})`);

  // 5. Límite por compra → fuera de límite NO se rechaza en seco: se escala al humano
  const amountOk = cart.amount <= mandate.max_amount;
  checks.push({ name: `límite por compra ($${mandate.max_amount})`, ok: amountOk, detail: `compra $${cart.amount}` });
  if (!amountOk) {
    return {
      status: 'pending_approval',
      reason: `monto $${cart.amount} excede el límite por compra de $${mandate.max_amount}: escalado a aprobación humana`,
      checks,
    };
  }

  // 6. Presupuesto total (atrapa compras divididas para evadir el límite por compra)
  const budgetOk = mandate.spent + cart.amount <= mandate.total_budget;
  checks.push({
    name: `presupuesto total ($${mandate.total_budget})`,
    ok: budgetOk,
    detail: `gastado $${mandate.spent} + compra $${cart.amount}`,
  });
  if (!budgetOk) return fail('excede el presupuesto total del mandato');

  // 7. Condiciones ricas
  const condChecks = conditions.evaluate(mandate, cart);
  checks.push(...condChecks);
  const badCond = condChecks.find((c) => !c.ok);
  if (badCond) return fail(`no cumple ${badCond.name} (${badCond.detail})`);

  return { status: 'approved', reason: 'todos los checks del mandato pasaron', checks };
}

module.exports = { verifyPurchase };
