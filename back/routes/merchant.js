const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { processCheckout } = require('../services/checkout');
const audit = require('../lib/audit');

// Merchant "VuelaYa": catálogo, checkout con verificación, y su vista de verificaciones.

router.get('/flights', (req, res) => {
  res.json(db.prepare('SELECT * FROM flights ORDER BY price ASC').all());
});

// Jueces: cambiar el precio en vivo → el agente reacciona solo
router.patch('/flights/:id', (req, res) => {
  const { price } = req.body;
  db.prepare('UPDATE flights SET price = ? WHERE id = ?').run(Number(price), req.params.id);
  const f = db.prepare('SELECT * FROM flights WHERE id = ?').get(req.params.id);
  audit.append('merchant', 'price_changed', { flight: `${f.origin} → ${f.destination}`, new_price: f.price });
  res.json(f);
});

// Checkout agéntico: aquí ocurre TODA la verificación del mandato
router.post('/checkout', (req, res) => {
  const { cart, agent_signature } = req.body;
  const result = processCheckout({ cart, agent_signature, actor: 'external' });
  res.status(result.status === 'rejected' ? 402 : 200).json(result);
});

// Lo que ve VuelaYa: cada intento con el detalle de sus checks
router.get('/verifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM purchases ORDER BY id DESC LIMIT 50').all();
  res.json(rows.map((p) => ({ ...p, checks: JSON.parse(p.checks_json || '[]') })));
});

module.exports = router;
