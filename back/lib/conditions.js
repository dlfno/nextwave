const { db } = require('../db');

// Evalúa las condiciones ricas del Intent Mandate contra un intento de compra concreto.
// Devuelve lista de checks {name, ok, detail} — todos deben pasar.

function evaluate(mandate, attempt) {
  const cond = JSON.parse(mandate.conditions_json || '{}');
  const checks = [];

  if (cond.price_below != null) {
    checks.push({
      name: `condición: precio < $${cond.price_below}`,
      ok: attempt.amount < cond.price_below,
      detail: `precio $${attempt.amount}`,
    });
  }

  if (cond.destination) {
    const ok = (attempt.destination || '').toLowerCase() === cond.destination.toLowerCase();
    checks.push({
      name: `condición: destino = ${cond.destination}`,
      ok,
      detail: `destino "${attempt.destination || '—'}"`,
    });
  }

  if (cond.max_uses_per_month != null) {
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM purchases
         WHERE mandate_id = ? AND status = 'approved'
           AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
      )
      .get(mandate.id);
    checks.push({
      name: `condición: máx. ${cond.max_uses_per_month} compras/mes`,
      ok: n < cond.max_uses_per_month,
      detail: `${n} compras este mes`,
    });
  }

  return checks;
}

module.exports = { evaluate };
