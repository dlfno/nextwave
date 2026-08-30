// Open Prices + Open Food Facts: precios reales observados en tiendas, con marca, gramaje,
// categoría y código de barras. Datos abiertos, sin API key y sin proveedor que pueda
// apagar el servicio como hizo Amadeus (DECISIONS #31, #32).
//
// Se entra por Open Prices, no por el catálogo: de los ~4M de productos de OFF solo una
// fracción tiene precio observado, y un candidato sin precio no sirve para un mandato de
// compra.

const { getJson } = require('../http');
const { candidato, parseCantidad } = require('../normalize');
const relevance = require('../../lib/relevance');

const PRECIOS = 'https://prices.openfoodfacts.org/api/v1';
const BUSQUEDA = 'https://search.openfoodfacts.org/search';

const id = 'openfoodfacts';
const productTypes = ['groceries'];

// El filtro de Open Prices es un LIKE simple: no entiende frases, hay que darle UN término.
// Se le da el mismo término principal que usa el filtro de relevancia, es decir el
// sustantivo con el que empieza la petición.
//
// Antes se elegía la palabra más larga, y para "café molido 500 g marca Carrefour" eso era
// "Carrefour": la API devolvía mayonesa y huevos de esa marca, el ticket los contaba como
// ofertas de café y la mediana del mercado salía de ahí (DECISIONS #32).
function termino(query) {
  return relevance.terms(query)[0] || '';
}

function primeraMarca(brands) {
  if (Array.isArray(brands)) return brands[0] || null;
  return brands ? String(brands).split(',')[0].trim() : null;
}

// Las categorías de OFF vienen como "en:ground-coffee"; se deja legible.
function categoria(tags) {
  const t = (tags || []).find((x) => typeof x === 'string');
  return t ? t.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ') : null;
}

async function ultimoPrecio(code) {
  try {
    const d = await getJson(`${PRECIOS}/prices?product_code=${encodeURIComponent(code)}&size=1&order_by=-date`);
    const item = (d.items || [])[0];
    if (!item?.price) return null;
    return { price: item.price, currency: item.currency || 'EUR', date: item.date, observaciones: d.total || 1 };
  } catch {
    return null;
  }
}

// Concurrencia acotada: 15 códigos secuenciales tardarían más que el presupuesto del ticket.
async function enParalelo(items, limite, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limite) {
    out.push(...(await Promise.all(items.slice(i, i + limite).map(fn))));
  }
  return out;
}

// Cuando el término no casa con ningún nombre en Open Prices, se prueba el catálogo
// completo de OFF: da menos precios pero más variedad de atributos.
async function porCatalogo(query) {
  const campos = 'code,product_name,brands,quantity,categories_tags,nutriscore_grade';
  const d = await getJson(`${BUSQUEDA}?q=${encodeURIComponent(query)}&page_size=20&fields=${campos}`);
  return (d.hits || []).filter((h) => h.code && h.product_name);
}

async function search(intent) {
  const q = termino(intent.query || '');
  if (!q) return { candidates: [], meta: { motivo: 'la consulta no tiene un término buscable' } };

  const url = `${PRECIOS}/products?product_name__like=${encodeURIComponent(q)}&price_count__gte=1&size=15&order_by=-price_count`;
  const d = await getJson(url);
  let items = (d.items || []).filter((p) => p.code && p.product_name);
  let via = 'open-prices';

  if (!items.length) {
    items = await porCatalogo(intent.query || q);
    via = 'catalogo-off';
  }

  const conPrecio = await enParalelo(items.slice(0, 15), 5, async (p) => {
    const precio = await ultimoPrecio(p.code);
    if (!precio) return null;
    const cantidad = p.quantity || (p.product_quantity ? `${p.product_quantity} ${p.product_quantity_unit || 'g'}` : null);
    return candidato({
      title: p.product_name,
      price: precio.price,
      currency: precio.currency,
      merchant: 'Open Prices (tiendas reales)',
      url: `https://world.openfoodfacts.org/product/${p.code}`,
      source: id,
      attributes: {
        marca: primeraMarca(p.brands),
        categoria: categoria(p.categories_tags),
        nutriscore: p.nutriscore_grade,
        cantidad,
        ...parseCantidad(cantidad),
        codigo_barras: p.code,
        precio_observado: precio.date,
        observaciones_de_precio: precio.observaciones,
      },
    });
  });

  const candidates = conPrecio.filter(Boolean);
  return { candidates, meta: { termino: q, via, evaluados: items.length, con_precio: candidates.length } };
}

module.exports = { id, productTypes, search, termino };
