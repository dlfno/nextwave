// El catálogo del propio merchant (VuelaYa). No es scraping externo, pero sí es la
// oferta contra la que el agente realmente va a comprar, así que tiene que entrar en la
// evidencia: un mandato "razonable" frente al mercado global pero imposible en la tienda
// donde se comprará no serviría de nada.
//
// También es el suelo de la demo: si internet se cae en la presentación, el ticket sigue
// teniendo evidencia real de dónde salen los precios que el agente ve.

const { db } = require('../../db');
const { candidato } = require('../normalize');
const { normText } = require('../../lib/spec');

const id = 'catalogo-vuelaya';
const productTypes = ['flights', 'groceries', 'generic'];

async function search(intent) {
  const rows = db.prepare('SELECT * FROM products WHERE product_type = ?').all(intent.product_type);
  const term = normText(intent.query || '');

  const candidates = rows
    .map((r) => ({ row: r, attrs: JSON.parse(r.attributes_json || '{}') }))
    .filter(({ row, attrs }) => {
      if (!term) return true;
      // Filtro laxo a propósito: la evidencia debe mostrar el mercado, no solo el ítem exacto
      const heno = normText([row.title, ...Object.values(attrs)].join(' '));
      return term.split(/\s+/).some((p) => p.length > 2 && heno.includes(p));
    })
    .map(({ row, attrs }) =>
      candidato({
        title: row.title,
        price: row.price,
        currency: row.currency,
        merchant: row.merchant,
        url: row.source_url,
        source: id,
        attributes: attrs,
      })
    );

  return { candidates, meta: { en_catalogo: rows.length, coincidencias: candidates.length } };
}

module.exports = { id, productTypes, search };
