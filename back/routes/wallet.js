const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { createMandate, resignMandate } = require('../services/mandates');
const { verifyPurchase } = require('../services/verify');
const tickets = require('../services/tickets');
const spec = require('../lib/spec');
const audit = require('../lib/audit');
const llm = require('../lib/llm');

// Wallet/Autorizador "PagoSeguro": emite mandatos, revoca, gestiona aprobaciones humanas.

router.get('/context', (req, res) => {
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  const agent = db.prepare('SELECT id, name FROM agents WHERE is_rogue = 0 LIMIT 1').get();
  const pm = db.prepare('SELECT id, brand, last4 FROM payment_methods WHERE user_id = ?').get(user.id);
  res.json({ user, agent, payment_method: pm, llm: llm.hasKey() });
});

// --- Tickets de mandato -------------------------------------------------------------
// Una petición del usuario → investigación real → ticket editable → firma.

router.get('/tickets', (req, res) => {
  res.json(tickets.list());
});

router.post('/tickets', (req, res) => {
  const { text } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'falta el texto de la petición' });
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  // Responde de inmediato con el ticket en 'researching': el scraping sigue en segundo
  // plano y el front lo ve llegar por polling.
  res.json(tickets.create(user.id, text));
});

router.get('/tickets/:id', (req, res) => {
  const t = tickets.view(tickets.row(req.params.id));
  if (!t) return res.status(404).json({ error: 'no existe' });
  res.json(t);
});

// El usuario cambia variables del ticket (marca, gramaje, tope de precio, fecha…)
router.patch('/tickets/:id', async (req, res) => {
  const t = await tickets.patch(req.params.id, req.body);
  if (!t) return res.status(404).json({ error: 'no existe' });
  res.json(t);
});

router.post('/tickets/:id/chat', async (req, res) => {
  const t = await tickets.chat(req.params.id, req.body.message);
  if (!t) return res.status(404).json({ error: 'no existe' });
  res.json(t);
});

// Volver a investigar: cambió qué se quiere comprar, no solo cuánto se quiere gastar
router.post('/tickets/:id/research', async (req, res) => {
  const t = await tickets.reinvestigar(req.params.id);
  if (!t) return res.status(404).json({ error: 'no existe' });
  res.json(t);
});

router.post('/tickets/:id/sign', (req, res) => {
  try {
    res.json(tickets.sign(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/tickets/:id/discard', (req, res) => {
  res.json(tickets.discard(req.params.id));
});

// --- Mandatos -----------------------------------------------------------------------

router.get('/mandates', (req, res) => {
  const rows = db.prepare('SELECT * FROM mandates ORDER BY id DESC').all();
  res.json(rows.map((m) => ({ ...m, spec: JSON.parse(m.spec_json || '[]') })));
});

// Alta directa sin ticket: la usa demo.sh y sirve de API para integradores.
router.post('/mandates', (req, res) => {
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  const agent = db.prepare('SELECT * FROM agents WHERE is_rogue = 0 LIMIT 1').get();
  const pm = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(user.id);
  const { product_type = 'flights', spec: rawSpec = [], max_amount, total_budget, max_uses_per_month, valid_until, nl_text } = req.body;
  if (!max_amount || !valid_until) return res.status(400).json({ error: 'max_amount y valid_until son obligatorios' });

  const row = createMandate({
    user_id: user.id,
    agent_id: agent.id,
    payment_method_id: pm.id,
    product_type,
    spec: spec.sanitize(rawSpec),
    max_amount: Number(max_amount),
    total_budget: Number(total_budget || max_amount),
    max_uses_per_month: max_uses_per_month != null ? Number(max_uses_per_month) : null,
    valid_from: new Date().toISOString(),
    valid_until: new Date(valid_until + 'T23:59:59').toISOString(),
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
  resignMandate(m.id);
  res.json({ ok: true });
});

// Verificación completa de un intento de compra: el merchant la invoca por HTTP en cada
// checkout (DECISIONS #33). La lógica es 100% determinista y vive en services/verify.js.
router.post('/verify', (req, res) => {
  const { cart, agent_signature } = req.body || {};
  if (!cart) return res.status(400).json({ error: 'falta cart' });
  res.json(verifyPurchase({ cart, agent_signature }));
});

// Estado en vivo (lo que consulta el merchant en cada verificación)
router.get('/mandates/:id/status', (req, res) => {
  const m = db.prepare('SELECT id, status, valid_until, spent, total_budget FROM mandates WHERE id = ?').get(req.params.id);
  res.json(m || { error: 'no existe' });
});

// --- Registro y aprobaciones ---------------------------------------------------------

router.get('/purchases', (req, res) => {
  const rows = db
    .prepare('SELECT p.*, m.product_type AS mandate_product_type FROM purchases p LEFT JOIN mandates m ON m.id = p.mandate_id ORDER BY p.id DESC LIMIT 100')
    .all();
  res.json(rows.map((p) => ({ ...p, checks: JSON.parse(p.checks_json || '[]'), attributes: JSON.parse(p.attributes_json || '{}') })));
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
