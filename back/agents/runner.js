const { db, ensureKeys } = require('../db');
const { sign } = require('../lib/crypto');
const { processCheckout } = require('../services/checkout');
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
  return `${m.id}:${m.status}:${m.max_amount}:${m.total_budget}:${m.spent}:${m.valid_until}:${m.conditions_json}`;
}

function buildCart(agent, mandate, flight) {
  return {
    mandate_id: mandate.id,
    agent_id: agent.id,
    flight_id: flight.id,
    description: `Vuelo ${flight.origin} → ${flight.destination} (${flight.airline})`,
    amount: flight.price,
    category: flight.category,
    destination: flight.destination,
    ts: new Date().toISOString(),
  };
}

async function attempt(mandate, flight, { forced = false } = {}) {
  const agent = goodAgent();
  const keys = ensureKeys('agent-marta');
  const cart = buildCart(agent, mandate, flight);
  const agent_signature = sign(cart, keys.private_key);

  const context = {
    flight: cart.description,
    price: flight.price,
    mandate: { max_amount: mandate.max_amount, conditions: JSON.parse(mandate.conditions_json || '{}') },
    forced,
  };
  let reasoning = forced
    ? `Intento comprar "${cart.description}" a $${flight.price} aunque supera mis límites (simulación de error del agente); el sistema debe frenarme.`
    : `Vi "${cart.description}" a $${flight.price}: cumple mi mandato (categoría, precio y presupuesto), así que compro.`;
  try {
    reasoning = await llm.explainDecision(context);
  } catch {
    /* fallback determinista */
  }

  audit.append('agent', forced ? 'agent_forced_attempt' : 'agent_purchase_attempt', {
    mandate_id: mandate.id,
    flight: cart.description,
    amount: flight.price,
    reasoning,
  });

  const result = processCheckout({ cart, agent_signature, actor: 'agent', agent_reasoning: reasoning });
  log(result.status === 'approved' ? 'ok' : result.status === 'pending_approval' ? 'warn' : 'error',
    `Intento de compra "${cart.description}" ($${flight.price}) → ${result.status}: ${result.reason}`);
  return result;
}

function localFit(mandate, flight) {
  // El agente obedece su mandato: solo intenta lo que cree que cumple
  const cond = JSON.parse(mandate.conditions_json || '{}');
  if (flight.category !== mandate.category) return false;
  if (cond.destination && flight.destination.toLowerCase() !== cond.destination.toLowerCase()) return false;
  if (cond.price_below != null && flight.price >= cond.price_below) return false;
  if (flight.price > mandate.max_amount) return false;
  if (mandate.spent + flight.price > mandate.total_budget) return false;
  return true;
}

function basicFit(mandate, flight) {
  const cond = JSON.parse(mandate.conditions_json || '{}');
  if (flight.category !== mandate.category) return false;
  if (cond.destination && flight.destination.toLowerCase() !== cond.destination.toLowerCase()) return false;
  if (cond.price_below != null && flight.price >= cond.price_below) return false;
  return true;
}

async function tick() {
  if (!running) return;
  const mandates = db.prepare("SELECT * FROM mandates").all();
  const flights = db.prepare('SELECT * FROM flights').all();

  for (const m of mandates) {
    for (const f of flights) {
      // Con mandato inactivo el agente evalúa solo lo básico (categoría/destino/precio) e
      // intenta igual: así el freno de la revocación se ve en vivo, no solo en teoría.
      const fits = m.status === 'active' ? localFit(m, f) : basicFit(m, f);
      if (!fits) continue;
      const key = `${mandateVersion(m)}|${f.id}:${f.price}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      await attempt(m, f);
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

// Para la demo: simular que el agente "alucina" e intenta un vuelo fuera de su mandato
async function forceAttempt(flight_id) {
  const flight = db.prepare('SELECT * FROM flights WHERE id = ?').get(flight_id);
  const mandate = db.prepare("SELECT * FROM mandates ORDER BY id DESC LIMIT 1").get();
  if (!flight || !mandate) throw new Error('falta vuelo o mandato');
  return attempt(mandate, flight, { forced: true });
}

module.exports = { start, stop, forceAttempt, decisions, isRunning: () => !!timer };
