const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { createMandate } = require('../services/mandates');
const audit = require('../lib/audit');
const llm = require('../lib/llm');

// Wallet/Autorizador "PagoSeguro": emite mandatos, revoca, gestiona aprobaciones humanas.

router.get('/context', (req, res) => {
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  const agent = db.prepare('SELECT id, name FROM agents WHERE is_rogue = 0 LIMIT 1').get();
  const pm = db.prepare('SELECT id, brand, last4 FROM payment_methods WHERE user_id = ?').get(user.id);
  res.json({ user, agent, payment_method: pm, llm: llm.hasKey() });
});

// Fallback determinista compartido: los valores del caso de demo. Se usa cuando no hay
// API key o la llamada al LLM falla — la demo nunca depende de OpenAI (DECISIONS #17).
function demoMandate() {
  const finDeMes = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  return {
    category: 'flights',
    destination: 'Córdoba',
    max_amount: 150,
    total_budget: 150,
    valid_until: `${finDeMes.getFullYear()}-${String(finDeMes.getMonth() + 1).padStart(2, '0')}-${String(finDeMes.getDate()).padStart(2, '0')}`,
    price_below: 150,
    max_uses_per_month: 1,
  };
}

// Normaliza lo que devuelve el LLM: números reales, sin valores absurdos, categoría fija.
// El modelo propone texto; los tipos y los defaults los impone el servidor.
function normalizeMandate(m) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const out = {
    category: 'flights',
    destination: m.destination ? String(m.destination) : null,
    max_amount: num(m.max_amount),
    total_budget: num(m.total_budget),
    valid_until: m.valid_until ? String(m.valid_until) : null,
    price_below: num(m.price_below),
    max_uses_per_month: num(m.max_uses_per_month),
  };
  // Misma regla que el prompt, pero aplicada de forma determinista por si el LLM la ignora
  if (out.price_below && !out.max_amount) out.max_amount = out.price_below;
  if (!out.total_budget && out.max_amount) out.total_budget = out.max_amount * (out.max_uses_per_month || 1);
  if (out.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(out.valid_until)) out.valid_until = null;
  return out;
}

// Campos sin los cuales un mandato no puede firmarse
function missingFields(m) {
  const missing = [];
  if (!m || !m.max_amount) missing.push('max_amount');
  if (!m || !m.valid_until) missing.push('valid_until');
  return missing;
}

// LLM: texto libre → Intent Mandate estructurado (Marta confirma antes de firmar)
router.post('/parse-mandate', async (req, res) => {
  const { text } = req.body;
  try {
    const parsed = await llm.parseMandate(text);
    res.json({ source: 'llm', mandate: parsed });
  } catch (e) {
    res.json({ source: 'fallback', error: e.message, mandate: demoMandate() });
  }
});

// Chat multi-turno: Marta conversa y el LLM va armando el mandato. Stateless — el
// frontend manda el historial completo en cada turno.
// El `ready` del LLM es solo una sugerencia: quien decide si el mandato está completo
// es este handler, sobre los campos requeridos (el LLM propone, el mandato dispone).
router.post('/mandate-chat', async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  try {
    const out = await llm.chatMandate(messages);
    const mandate = out.mandate ? normalizeMandate(out.mandate) : null;
    const missing = missingFields(mandate);
    const ready = missing.length === 0;
    // El LLM aporta naturalidad mientras pregunta, pero el turno del hand-off es
    // determinista: su texto podría contradecir el mandato que se va a firmar
    // (visto en pruebas: decía "ready" y a la vez pedía un dato que ya tenía).
    const preguntas = { max_amount: '¿Cuánto como máximo por compra?', valid_until: '¿Hasta qué fecha quieres que valga el mandato?' };
    const reply = ready
      ? 'Con eso ya tengo todo. Te muestro el mandato completo: revísalo y fírmalo si estás de acuerdo.'
      : String(out.reply || preguntas[missing[0]] || '');
    res.json({ source: 'llm', reply, mandate, ready, missing });
  } catch (e) {
    // Sin LLM la conversación se degrada a un turno: proponemos el mandato de la demo
    // y que Marta lo revise en el box de confirmación. El badge lo declara como fallback.
    res.json({
      source: 'fallback',
      error: e.message,
      reply: 'No pude consultar al modelo, así que te propongo el mandato de la demo. Revísalo y ajústalo antes de firmar.',
      mandate: demoMandate(),
      ready: true,
      missing: [],
    });
  }
});

router.get('/mandates', (req, res) => {
  const rows = db.prepare('SELECT * FROM mandates ORDER BY id DESC').all();
  res.json(rows.map((m) => ({ ...m, conditions: JSON.parse(m.conditions_json || '{}') })));
});

router.post('/mandates', (req, res) => {
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  const agent = db.prepare('SELECT * FROM agents WHERE is_rogue = 0 LIMIT 1').get();
  const pm = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(user.id);
  const { category = 'flights', destination, max_amount, total_budget, valid_until, price_below, max_uses_per_month, nl_text } = req.body;

  const conditions = {};
  if (destination) conditions.destination = destination;
  if (price_below != null && price_below !== '') conditions.price_below = Number(price_below);
  if (max_uses_per_month != null && max_uses_per_month !== '') conditions.max_uses_per_month = Number(max_uses_per_month);

  const row = createMandate({
    user_id: user.id,
    agent_id: agent.id,
    payment_method_id: pm.id,
    category,
    max_amount: Number(max_amount),
    total_budget: Number(total_budget || max_amount),
    valid_from: new Date().toISOString(),
    valid_until: new Date(valid_until + 'T23:59:59').toISOString(),
    conditions,
    nl_text,
  });
  res.json(row);
});

router.post('/mandates/:id/revoke', (req, res) => {
  db.prepare("UPDATE mandates SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?").run(req.params.id);
  audit.append('human', 'mandate_revoked', { mandate_id: Number(req.params.id) });
  res.json({ ok: true });
});

// Jueces: cambiar límites en vivo
router.patch('/mandates/:id', (req, res) => {
  const { max_amount, total_budget, valid_until } = req.body;
  const m = db.prepare('SELECT * FROM mandates WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'no existe' });
  db.prepare('UPDATE mandates SET max_amount = ?, total_budget = ?, valid_until = ? WHERE id = ?').run(
    max_amount ?? m.max_amount,
    total_budget ?? m.total_budget,
    valid_until ? new Date(valid_until + 'T23:59:59').toISOString() : m.valid_until,
    m.id
  );
  audit.append('human', 'mandate_limits_changed', { mandate_id: m.id, max_amount, total_budget, valid_until });
  // Nota: cambiar el mandato invalida la firma anterior → el Wallet lo re-firma
  const { mandatePayload } = require('../services/mandates');
  const { ensureKeys } = require('../db');
  const { sign } = require('../lib/crypto');
  const updated = db.prepare('SELECT * FROM mandates WHERE id = ?').get(m.id);
  const signature = sign(mandatePayload(updated), ensureKeys('wallet').private_key);
  db.prepare('UPDATE mandates SET wallet_signature = ? WHERE id = ?').run(signature, m.id);
  res.json({ ok: true });
});

// Estado en vivo (lo que consulta el merchant en cada verificación)
router.get('/mandates/:id/status', (req, res) => {
  const m = db.prepare('SELECT id, status, valid_until, spent, total_budget FROM mandates WHERE id = ?').get(req.params.id);
  res.json(m || { error: 'no existe' });
});

// Registro de compras que ve Marta
router.get('/purchases', (req, res) => {
  const rows = db
    .prepare('SELECT p.*, m.category AS mandate_category FROM purchases p LEFT JOIN mandates m ON m.id = p.mandate_id ORDER BY p.id DESC LIMIT 100')
    .all();
  res.json(rows.map((p) => ({ ...p, checks: JSON.parse(p.checks_json || '[]') })));
});

// Human-in-the-loop: aprobaciones pendientes
router.get('/approvals', (req, res) => {
  res.json(db.prepare("SELECT * FROM purchases WHERE status = 'pending_approval' ORDER BY id DESC").all());
});

router.post('/approvals/:purchaseId', (req, res) => {
  const { decision } = req.body; // 'approve' | 'deny'
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.purchaseId);
  if (!p || p.status !== 'pending_approval') return res.status(400).json({ error: 'no está pendiente' });

  if (decision === 'approve') {
    db.prepare("UPDATE purchases SET status = 'approved', reason = reason || ' — aprobada explícitamente por el titular', resolved_at = datetime('now') WHERE id = ?").run(p.id);
    db.prepare('UPDATE mandates SET spent = spent + ?, uses = uses + 1 WHERE id = ?').run(p.amount, p.mandate_id);
    audit.append('human', 'escalation_approved', { purchase_id: p.id, amount: p.amount });
  } else {
    db.prepare("UPDATE purchases SET status = 'denied', reason = reason || ' — denegada por el titular', resolved_at = datetime('now') WHERE id = ?").run(p.id);
    audit.append('human', 'escalation_denied', { purchase_id: p.id, amount: p.amount });
  }
  res.json({ ok: true });
});

module.exports = router;
