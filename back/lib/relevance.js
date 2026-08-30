// Filtro de relevancia de los candidatos del scraping. Determinista, sin LLM.
//
// Sin esto la evidencia mentía sobre sí misma: pidiendo "café molido 500 g marca
// Carrefour" el ticket enseñaba "17 ofertas reales" y el veredicto contaba mayonesa y
// huevos de la marca Carrefour como compras válidas de café. Las estadísticas de mercado
// (mínimo, mediana) salían de productos que no eran el producto, y sobre esa mediana se
// decidía si la petición era razonable (DECISIONS #32).
//
// Un candidato no basta con que exista: tiene que ser plausiblemente *lo que se pidió*.

const { normText } = require('./spec');

// Palabras que no discriminan producto: conectores, ruido de compra y unidades.
// "marca" y "comprar" aparecen en la petición pero no dicen qué es el producto.
const VACIAS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'con', 'sin', 'por',
  'para', 'que', 'the', 'and', 'of',
  'comprar', 'compra', 'precio', 'precios', 'barato', 'barata', 'baratos', 'oferta', 'ofertas',
  'tienda', 'online', 'menos', 'mas', 'hasta', 'marca', 'modelo', 'quiero', 'busco', 'necesito',
  'baja', 'bajar', 'baje', 'cuesta', 'cueste', 'vale', 'valga', 'cada', 'mes', 'vez', 'veces',
  'g', 'gr', 'grs', 'gramo', 'gramos', 'kg', 'kilo', 'kilos', 'ml', 'cl', 'lt', 'litro', 'litros',
  'euro', 'euros', 'dolar', 'dolares', 'peso', 'pesos', 'usd', 'eur', 'mxn', 'ars',
]);

// Términos que sí discriminan. Los números se descartan: "500" casa con cualquier título
// que lleve un 500 y el gramaje ya lo verifica la spec, con unidades y todo.
function terms(query) {
  return [
    ...new Set(
      normText(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2 && !VACIAS.has(t) && !/^\d+$/.test(t))
    ),
  ];
}

// Dónde se busca: el título y los valores de los atributos (marca, categoría…), que es
// donde la tienda dice qué está vendiendo.
function haystack(c) {
  return normText([c.title, c.merchant, ...Object.values(c.attributes || {})].filter(Boolean).join(' '));
}

// Un candidato pasa si casa el término principal —el sustantivo con el que empieza la
// petición: "café", "vuelo"— o si casa la mayoría de los términos. Lo primero es lo que
// separa el café de la mayonesa; lo segundo rescata peticiones donde el usuario empieza
// por la marca ("Carrefour café molido").
const MAYORIA = 0.6;

function evaluate(candidate, lista) {
  if (!lista.length) return { ok: true, score: 1, matched: [] };
  const heno = haystack(candidate);
  const matched = lista.filter((t) => heno.includes(t));
  const score = matched.length / lista.length;
  return { ok: matched.includes(lista[0]) || score >= MAYORIA, score, matched };
}

// Devuelve los relevantes y, por separado, lo descartado: el ticket enseña cuántos
// candidatos se tiraron y por qué. La evidencia tiene que decir la verdad sobre sí misma,
// también cuando lo que hizo fue descartar.
function filter(candidates, query) {
  const lista = terms(query);
  const relevantes = [];
  const descartados = [];
  for (const c of candidates) {
    const r = evaluate(c, lista);
    if (r.ok) relevantes.push(c);
    else descartados.push({ title: c.title, source: c.source, score: Math.round(r.score * 100) / 100 });
  }
  return { relevantes, descartados, terminos: lista };
}

module.exports = { filter, evaluate, terms };
