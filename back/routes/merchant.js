const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { processCheckout } = require('../services/checkout');
const audit = require('../lib/audit');

// Merchant "VuelaYa": catálogo, checkout con verificación, y su vista de verificaciones.
// El catálogo ya no es solo de vuelos: `products` guarda cualquier tipo con sus atributos.

function conAtributos(p) {
  return { ...p, attributes: JSON.parse(p.attributes_json || '{}') };
}

router.get('/products', (req, res) => {
  const { product_type } = req.query;
  const rows = product_type
    ? db.prepare('SELECT * FROM products WHERE product_type = ? ORDER BY price ASC').all(product_type)
    : db.prepare('SELECT * FROM products ORDER BY product_type, price ASC').all();
  res.json(rows.map(conAtributos));
});

// Jueces: cambiar el precio en vivo → el agente reacciona solo
router.patch('/products/:id', (req, res) => {
  const { price } = req.body;
  db.prepare('UPDATE products SET price = ? WHERE id = ?').run(Number(price), req.params.id);
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  audit.append('merchant', 'price_changed', { product: p.title, new_price: p.price });
  res.json(conAtributos(p));
});

// Checkout agéntico: aquí ocurre TODA la verificación del mandato
router.post('/checkout', async (req, res) => {
  const { cart, agent_signature, actor, agent_reasoning } = req.body;
  const result = await processCheckout({
    cart,
    agent_signature,
    actor: actor || 'external',
    agent_reasoning: agent_reasoning || null,
  });
  res.status(result.status === 'rejected' ? 402 : 200).json(result);
});

// Lo que ve VuelaYa: cada intento con el detalle de sus checks
router.get('/verifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM purchases ORDER BY id DESC LIMIT 50').all();
  res.json(rows.map((p) => ({ ...p, checks: JSON.parse(p.checks_json || '[]'), attributes: JSON.parse(p.attributes_json || '{}') })));
});

module.exports = router;
