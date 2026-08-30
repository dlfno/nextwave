// Normalización de lo que devuelve el scraping. Cada fuente escribe los atributos a su
// manera ("500 g", "0,5kg", "$1.299,00 MXN") y el motor de spec compara números.
// Todo lo que no se pueda normalizar con certeza se deja fuera: es preferible que un
// atributo falte (y el check falle por no verificable) a inventarle un valor.

const UNIDADES_MASA = { mg: 0.001, g: 1, gr: 1, grs: 1, gramos: 1, kg: 1000, kgs: 1000, lb: 453.592, lbs: 453.592, oz: 28.3495 };
const UNIDADES_VOLUMEN = { ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000, litros: 1000 };

// "500 g" → {gramaje_g: 500}; "1,5 L" → {volumen_ml: 1500}
function parseCantidad(texto) {
  if (!texto) return {};
  const m = String(texto)
    .toLowerCase()
    .replace(',', '.')
    .match(/(\d+(?:\.\d+)?)\s*([a-záéíóú]+)/);
  if (!m) return {};
  const n = Number(m[1]);
  const u = m[2];
  if (!Number.isFinite(n)) return {};
  if (UNIDADES_MASA[u]) return { gramaje_g: Math.round(n * UNIDADES_MASA[u] * 100) / 100 };
  if (UNIDADES_VOLUMEN[u]) return { volumen_ml: Math.round(n * UNIDADES_VOLUMEN[u] * 100) / 100 };
  return {};
}

// Precios en cualquier formato razonable. Distingue "1.299,00" (es) de "1,299.00" (en)
// por cuál separador aparece último.
function parsePrecio(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (!valor) return null;
  const s = String(valor).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const ultimaComa = s.lastIndexOf(',');
  const ultimoPunto = s.lastIndexOf('.');
  let limpio;
  if (ultimaComa > ultimoPunto) limpio = s.replace(/\./g, '').replace(',', '.');
  else limpio = s.replace(/,/g, '');
  const n = Number(limpio);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMoneda(texto, porDefecto = 'USD') {
  const s = String(texto || '').toUpperCase();
  const codigo = s.match(/\b(USD|EUR|MXN|ARS|GBP|BRL|CLP|COP|PEN)\b/);
  if (codigo) return codigo[1];
  if (s.includes('€')) return 'EUR';
  if (s.includes('£')) return 'GBP';
  return porDefecto;
}

const limpiar = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Marcadores de "no lo sé" que algunas tiendas publican como si fueran un valor. Un
// mandato con la condición marca = "Unknown" sería absurdo, y el motor de spec la trataría
// como un valor legítimo.
const SIN_VALOR = new Set(['unknown', 'n/a', 'na', 'null', 'none', 'undefined', '-', '--', 'sin marca', 'no aplica']);

// Forma canónica de un candidato del scraping. Todos los adaptadores devuelven esto,
// así el resto del sistema no sabe de qué fuente vino.
function candidato({ title, price, currency, merchant, url, source, attributes = {} }) {
  const precio = parsePrecio(price);
  const attrs = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v !== 'number' && SIN_VALOR.has(limpiar(v).toLowerCase())) continue;
    attrs[k] = typeof v === 'number' ? v : limpiar(v);
  }
  return {
    title: limpiar(title),
    price: precio,
    currency: currency || 'USD',
    merchant: limpiar(merchant) || null,
    url: url || null,
    source,
    attributes: attrs,
  };
}

module.exports = { parseCantidad, parsePrecio, parseMoneda, candidato, limpiar };
