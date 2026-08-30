const { db, ensureKeys } = require('../db');
const { sign } = require('../lib/crypto');
const { postJson } = require('../lib/rpc');
const { merchantUrl } = require('../config');
const spec = require('../lib/spec');
const audit = require('../lib/audit');
const llm = require('../lib/llm');

// Agente legítimo de Marta: loop determinista que vigila precios y compra dentro de su mandato.
// La capa LLM solo redacta la explicación; la decisión es determinista.

const decisions = []; // consola del agente (en memoria)
const attempted = new Set(); // dedupe: no reintentar lo mismo hasta que algo cambie
let timer = null;
let running = true;

function log(level, message, extra = {}) {
  decisions.unshift({ ts: new Date().toISOString(), level, message, ...extra });
  if (decisions.length > 80) decisions.pop();
}

function goodAgent() {
  return db.prepare('SELECT * FROM agents WHERE is_rogue = 0 LIMIT 1').get();
}

function mandateVersion(m) {
  return `${m.id}:${m.status}:${m.max_amount}:${m.total_budget}:${m.spent}:${m.valid_until}:${m.spec_json}`;
}

function buildCart(agent, mandate, product) {
  return {
    mandate_id: mandate.id,
    agent_id: agent.id,
    product_id: product.id,
    description: product.title,
    amount: product.price,
    product_type: product.product_type,
    attributes: JSON.parse(product.attributes_json || '{}'),
    ts: new Date().toISOString(),
  };
}

async function attempt(mandate, product, { forced = false } = {}) {
  const agent = goodAgent();
  const keys = ensureKeys('agent-marta');
  const cart = buildCart(agent, mandate, product);
  const agent_signature = sign(cart, keys.private_key);

  const context = {
    producto: cart.description,
    price: product.price,
    mandate: { max_amount: mandate.max_amount, spec: JSON.parse(mandate.spec_json || '[]') },
    forced,
  };
  let reasoning = forced
    ? `Intento comprar "${cart.description}" a $${product.price} aunque supera mis límites (simulación de error del agente); el sistema debe frenarme.`
    : `Vi "${cart.description}" a $${product.price}: cumple mi mandato (tipo, precio, condiciones y presupuesto), así que compro.`;
  try {
    reasoning = await llm.explainDecision(context);
  } catch {
    /* fallback determinista */
  }

  audit.append('agent', forced ? 'agent_forced_attempt' : 'agent_purchase_attempt', {
    mandate_id: mandate.id,
    producto: cart.description,
    amount: product.price,
    reasoning,
  });

  let result;
  try {
    result = await postJson(`${merchantUrl}/api/merchant/checkout`, {
      cart,
      agent_signature,
      actor: 'agent',
      agent_reasoning: reasoning,
    });
  } catch (e) {
    log('error', `No pude contactar al merchant para "${cart.description}": ${e.message}`);
    return { status: 'error', reason: e.message };
  }
  log(result.status === 'approved' ? 'ok' : result.status === 'pending_approval' ? 'warn' : 'error',
    `Intento de compra "${cart.description}" ($${product.price}) → ${result.status}: ${result.reason}`);
  return result;
}

// El agente evalúa su propio mandato con el MISMO motor que usa el merchant: si aquí y
// allá se evaluara distinto, la demo mentiría sobre por qué compró o no compró.
function specChecksOk(mandate, product) {
  const attributes = { ...JSON.parse(product.attributes_json || '{}'), price: product.price };
  return spec.evaluate(JSON.parse(mandate.spec_json || '[]'), attributes).every((c) => c.ok);
}

function localFit(mandate, product) {
  // El agente obedece su mandato: solo intenta lo que cree que cumple
  if (product.product_type !== mandate.product_type) return false;
  if (!specChecksOk(mandate, product)) return false;
  if (product.price > mandate.max_amount) return false;
  if (mandate.spent + product.price > mandate.total_budget) return false;
  return true;
}

function basicFit(mandate, product) {
  if (product.product_type !== mandate.product_type) return false;
  return specChecksOk(mandate, product);
}

async function tick() {
  if (!running) return;
  const mandates = db.prepare('SELECT * FROM mandates').all();
  const products = db.prepare('SELECT * FROM products').all();

  for (const m of mandates) {
    for (const p of products) {
      // Con mandato inactivo el agente evalúa solo las condiciones del producto e intenta
      // igual: así el freno de la revocación se ve en vivo, no solo en teoría.
      const fits = m.status === 'active' ? localFit(m, p) : basicFit(m, p);
      if (!fits) continue;
      const key = `${mandateVersion(m)}|${p.id}:${p.price}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      await attempt(m, p);
    }
  }
}

function start() {
  if (timer) return;
  running = true;
  timer = setInterval(() => tick().catch((e) => log('error', `Error del loop: ${e.message}`)), 3000);
  log('info', 'Agente iniciado: vigilando precios cada 3s.');
}

function stop() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  log('info', 'Agente detenido.');
}

// Para la demo: simular que el agente "alucina" e intenta un producto fuera de su mandato
async function forceAttempt(product_id) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  const mandate = db.prepare('SELECT * FROM mandates ORDER BY id DESC LIMIT 1').get();
  if (!product || !mandate) throw new Error('falta producto o mandato');
  return attempt(mandate, product, { forced: true });
}

module.exports = { start, stop, forceAttempt, decisions, isRunning: () => !!timer };
