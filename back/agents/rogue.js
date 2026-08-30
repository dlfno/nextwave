const { db, ensureKeys } = require('../db');
const { sign } = require('../lib/crypto');
const { postJson } = require('../lib/rpc');
const { merchantUrl } = require('../config');
const audit = require('../lib/audit');

// Agente adversarial (bonus): intenta comprar fuera del mandato por caminos creativos.
// Dos vectores: (a) impersonación — no tiene la llave del agente legítimo;
// (b) agente comprometido — tiene la llave pero intenta evadir los límites.

function latestMandate() {
  const m = db.prepare('SELECT * FROM mandates ORDER BY id DESC LIMIT 1').get();
  if (!m) throw new Error('no hay mandatos para atacar');
  return m;
}

async function run(cart, keyName, attackName) {
  const keys = ensureKeys(keyName);
  const agent_signature = sign(cart, keys.private_key);
  audit.append('rogue-agent', 'rogue_attack_attempt', { attack: attackName, description: cart.description, amount: cart.amount });
  let result;
  try {
    result = await postJson(`${merchantUrl}/api/merchant/checkout`, {
      cart,
      agent_signature,
      actor: 'rogue-agent',
      agent_reasoning: `ATAQUE (${attackName}): intento comprar fuera del mandato.`,
    });
  } catch (e) {
    result = { status: 'error', reason: e.message };
  }
  return { attack: attackName, status: result.status, reason: result.reason };
}

async function attackAll() {
  const m = latestMandate();
  const rogueAgent = db.prepare('SELECT * FROM agents WHERE is_rogue = 1 LIMIT 1').get();
  const goodAgent = db.prepare('SELECT * FROM agents WHERE is_rogue = 0 LIMIT 1').get();
  const results = [];

  // El carrito base imita al del agente legítimo: mismo tipo de producto y atributos
  // plausibles. Lo que falla en cada ataque es la firma o los límites, no el formato.
  const base = {
    mandate_id: m.id,
    product_id: null,
    product_type: m.product_type,
    attributes: { destination: 'Córdoba', airline: 'AeroSur' },
    ts: new Date().toISOString(),
  };

  // 1. Impersonación: firma con SU llave, no con la ligada al mandato → firma inválida
  results.push(
    await run(
      { ...base, agent_id: rogueAgent.id, description: 'Vuelo premium a Córdoba (impersonando al agente de Marta)', amount: 120 },
      'agent-rogue',
      'impersonación: firma con llave ajena'
    )
  );

  // 2. Agente comprometido: llave válida, pero compra de otra categoría disfrazada
  results.push(
    await run(
      { ...base, agent_id: goodAgent.id, product_type: 'electronics', attributes: {}, description: 'Consola de videojuegos "etiquetada" como viaje', amount: 90 },
      'agent-marta',
      'tipo de producto disfrazado'
    )
  );

  // 3. Compra dividida: dos cargos chicos que juntos rompen el presupuesto total
  const half = Math.ceil(m.total_budget * 0.7);
  results.push(
    await run({ ...base, agent_id: goodAgent.id, description: `Vuelo a Córdoba (parte 1 de compra dividida, $${half})`, amount: half }, 'agent-marta', 'compra dividida 1/2')
  );
  results.push(
    await run({ ...base, agent_id: goodAgent.id, description: `Vuelo a Córdoba (parte 2 de compra dividida, $${half})`, amount: half }, 'agent-marta', 'compra dividida 2/2')
  );

  // 4. Monto gigante directo → debe escalar o rechazar, nunca pasar en silencio
  results.push(
    await run({ ...base, agent_id: goodAgent.id, description: 'Vuelo en primera clase a Córdoba', amount: 999 }, 'agent-marta', 'monto excedido')
  );

  // 5. Mandato inexistente / expirado
  results.push(
    await run({ ...base, mandate_id: 999999, agent_id: goodAgent.id, description: 'Compra contra mandato inexistente', amount: 50 }, 'agent-marta', 'mandato inexistente')
  );

  const silent = results.filter((r) => r.status === 'approved' && !r.attack.includes('dividida 1/2'));
  audit.append('auditor', 'rogue_attack_summary', {
    total: results.length,
    blocked: results.filter((r) => r.status !== 'approved').length,
    silently_approved: silent.length,
  });
  return results;
}

module.exports = { attackAll };
