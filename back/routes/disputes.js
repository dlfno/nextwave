const express = require('express');
const router = express.Router();
const { db } = require('../db');
const audit = require('../lib/audit');
const llm = require('../lib/llm');

// Disputa (bonus): Marta niega una compra; el trail auditable resuelve quién responde.

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM disputes ORDER BY id DESC').all());
});

router.post('/', (req, res) => {
  const { purchase_id, claim } = req.body;
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  const info = db.prepare('INSERT INTO disputes (purchase_id, user_id, claim) VALUES (?, ?, ?)').run(purchase_id, user.id, claim || 'Yo no autoricé esta compra');
  audit.append('human', 'dispute_opened', { dispute_id: info.lastInsertRowid, purchase_id, claim });
  res.json({ id: info.lastInsertRowid });
});

// Resolución determinista por replay del trail; el LLM solo redacta el veredicto legible
router.post('/:id/resolve', async (req, res) => {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'no existe' });
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(d.purchase_id);
  const m = p.mandate_id ? db.prepare('SELECT * FROM mandates WHERE id = ?').get(p.mandate_id) : null;
  const chain = audit.verifyChain();
  const checks = JSON.parse(p.checks_json || '[]');

  // Replay determinista de la evidencia
  const evidence = {
    chain_integrity: chain.ok,
    purchase_status: p.status,
    all_checks_passed: checks.length > 0 && checks.every((c) => c.ok),
    human_explicitly_approved: (p.reason || '').includes('aprobada explícitamente'),
    mandate_active_at_purchase: m ? !m.revoked_at || p.created_at < m.revoked_at : false,
  };

  let verdict, detail;
  if (p.status !== 'approved') {
    verdict = 'sin_cargo';
    detail = 'La compra disputada nunca fue aprobada: no hubo cargo que revertir. El sistema ya la había frenado.';
  } else if (!evidence.chain_integrity) {
    verdict = 'merchant';
    detail = 'El trail auditable está roto: la evidencia del merchant no es confiable. Se revierte el cargo (chargeback).';
  } else if (evidence.human_explicitly_approved) {
    verdict = 'user';
    detail = 'El trail muestra que el titular aprobó explícitamente esta compra escalada. El cargo se sostiene.';
  } else if (evidence.all_checks_passed && evidence.mandate_active_at_purchase) {
    verdict = 'user';
    detail = 'Firma del Wallet válida, firma del agente válida, mandato activo y dentro de límites al momento de la compra. El mandato del titular cubría esta compra: el cargo se sostiene.';
  } else {
    verdict = 'merchant';
    detail = 'El merchant aprobó una compra sin verificación completa del mandato. Se revierte el cargo (chargeback).';
  }

  let verdictText = detail;
  try {
    verdictText = await llm.draftDisputeVerdict({ claim: d.claim, purchase: p.description, amount: p.amount, evidence, verdict, base_detail: detail });
  } catch {
    /* fallback determinista */
  }

  db.prepare("UPDATE disputes SET status = 'resolved', verdict = ?, verdict_detail = ?, resolved_at = datetime('now') WHERE id = ?").run(verdict, verdictText, d.id);
  audit.append('auditor', 'dispute_resolved', { dispute_id: d.id, purchase_id: d.purchase_id, verdict, evidence });
  res.json({ verdict, detail: verdictText, evidence });
});

module.exports = router;
