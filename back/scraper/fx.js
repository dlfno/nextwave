// Conversión de divisas. El scraping real trae precios en la moneda de cada tienda: un
// candidato de $163 MXN y otro de $189 USD no se pueden comparar, y sin esto las
// estadísticas del mercado (y el juicio de razonabilidad) saldrían mal.
//
// Fuentes reales y sin API key, en orden: Frankfurter (datos del BCE, cobertura de las
// ~30 monedas mayores) y open.er-api.com como respaldo, que sí cubre monedas fuera del
// BCE como ARS o COP. Se cachea un día.
// Si ninguna responde, NO se inventa un tipo de cambio: el candidato en otra moneda se
// queda fuera de la comparación y la evidencia lo dice.

const { getJson } = require('./http');
const cache = require('./cache');

const UN_DIA = 24 * 60 * 60 * 1000;

const PROVEEDORES = [
  {
    id: 'frankfurter',
    url: (base) => `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}`,
    lee: (d) => (d.rates ? { rates: d.rates, actualizado: d.date } : null),
  },
  {
    id: 'open-er-api',
    url: (base) => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    lee: (d) => (d.result === 'success' && d.rates ? { rates: d.rates, actualizado: d.time_last_update_utc } : null),
  },
];

async function tasas(base) {
  const key = cache.key('fx', base);
  const { rates } = await cache.through(
    key,
    async () => {
      const fallos = [];
      for (const p of PROVEEDORES) {
        try {
          const leido = p.lee(await getJson(p.url(base)));
          if (leido) return { ...leido, proveedor: p.id };
          fallos.push(`${p.id}: respuesta sin tasas`);
        } catch (e) {
          fallos.push(`${p.id}: ${e.message}`);
        }
      }
      throw new Error(`ningún proveedor de tipos de cambio respondió (${fallos.join('; ')})`);
    },
    UN_DIA
  );
  return rates;
}

// Devuelve los candidatos con `price` en la moneda objetivo, conservando el original en
// `attributes.precio_original` para que el ticket pueda enseñar de dónde salió.
async function normalizar(candidates, objetivo = 'USD') {
  const monedas = [...new Set(candidates.map((c) => c.currency).filter(Boolean))];
  if (monedas.length <= 1 && monedas[0] === objetivo) return { candidates, fx: null };

  let rates;
  try {
    rates = await tasas(objetivo);
  } catch (e) {
    return { candidates, fx: { ok: false, error: e.message } };
  }

  const convertidos = [];
  const sinTasa = [];
  for (const c of candidates) {
    if (c.currency === objetivo) {
      convertidos.push(c);
      continue;
    }
    const tasa = rates[c.currency];
    if (!tasa) {
      sinTasa.push(c.currency);
      continue; // sin tasa no se compara: preferimos una muestra menos a un número falso
    }
    convertidos.push({
      ...c,
      price: Math.round((c.price / tasa) * 100) / 100,
      currency: objetivo,
      attributes: { ...c.attributes, precio_original: `${c.price} ${c.currency}` },
    });
  }

  return {
    candidates: convertidos,
    fx: { ok: true, objetivo, monedas, descartadas_sin_tasa: [...new Set(sinTasa)] },
  };
}

module.exports = { normalizar, tasas };
