// Adaptador de investigación: es la única fuente de datos de producto del sistema.
// No hay APIs de catálogo detrás — se sale a la web abierta y se lee lo que las tiendas
// publican (DECISIONS #32).
//   1. Buscar en DuckDuckGo (endpoint lite, sin API key ni tracking), con varias
//      formulaciones de la consulta: una sola búsqueda deja fuera la mitad de las tiendas
//      y algunas peticiones devuelven cero por rate limit.
//   2. Descargar cada resultado respetando robots.txt.
//   3. Extraer el producto del HTML. Orden de confianza:
//        a) JSON-LD schema.org/Product  → lo publican casi todos los e-commerce y es el
//           dato que la propia tienda declara: no hay heurística que adivinar.
//        b) Open Graph / microdata       → menos rico pero muy estable.
//        c) LLM sobre el texto limpio    → último recurso, solo si a y b no dieron precio.
//
// Nunca se rellena un atributo por inferencia: si la página no lo dice, no está.

const cheerio = require('cheerio');
const { getText, permitido } = require('../http');
const { candidato, parsePrecio, parseMoneda, parseCantidad, limpiar } = require('../normalize');
const llm = require('../../lib/llm');

const id = 'web';
const productTypes = ['generic'];
const MAX_PAGINAS = 10;
// Presupuesto por página. Las páginas se visitan en paralelo, así que este es también el
// techo de la fase de extracción: una tienda lenta no puede arrastrar al ticket entero.
const MS_POR_PAGINA = Number(process.env.SCRAPE_PAGE_MS || 11000);

function conLimite(promesa, ms) {
  let timer;
  const limite = new Promise((resolver) => {
    timer = setTimeout(() => resolver({ vencida: true }), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

// --- 1. Búsqueda -----------------------------------------------------------------

// DDG envuelve los enlaces en /l/?uddg=<url codificada>; los anuncios pasan por y.js o
// bing.com/aclick y se descartan: no son la oferta real de una tienda.
function limpiarEnlace(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.pathname.startsWith('/l/')) {
      const real = u.searchParams.get('uddg');
      if (!real) return null;
      return limpiarEnlace(decodeURIComponent(real));
    }
    if (/duckduckgo\.com|bing\.com\/aclick|\/y\.js/.test(u.href)) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

async function buscar(query) {
  const html = await getText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
  });
  const $ = cheerio.load(html);
  const urls = [];
  $('a.result-link').each((_, el) => {
    const u = limpiarEnlace($(el).attr('href'));
    if (u && !urls.includes(u)) urls.push(u);
  });
  // Cero resultados con una respuesta que sí trae contenido = el buscador nos está
  // frenando (DuckDuckGo devuelve 202 con una página de anomalía, no un error HTTP).
  // Hay que distinguirlo de "no hay nada que comprar": si esto se reportara como éxito,
  // el ticket enseñaría "0 ofertas" como si el mercado estuviera vacío.
  if (!urls.length) {
    const bloqueado = /captcha|anomaly|unusual traffic|robot/i.test(html) || html.length > 2000;
    if (bloqueado) throw new Error('el buscador bloqueó la consulta (rate limit o captcha)');
  }
  return urls;
}

// Distintas formulaciones de la misma petición. Medido: una sola consulta daba 9 URLs y
// combinando tres se llegó a 14 de tiendas distintas — y una de las tres devolvió cero,
// así que además es la red de seguridad contra el rate limit de DuckDuckGo.
function variantes(query) {
  return [`${query} comprar precio`, `${query} tienda online`, `comprar ${query}`];
}

// Las búsquedas van por separado: que una falle no puede tumbar al resto. Pero si fallan
// TODAS, el adaptador entero falla — es la diferencia entre "no encontré nada" y "no pude
// mirar", y la evidencia tiene que decir cuál de las dos fue.
async function buscarTodas(query) {
  const tandas = await Promise.allSettled(variantes(query).map(buscar));
  const urls = [];
  for (const t of tandas) {
    if (t.status !== 'fulfilled') continue;
    for (const u of t.value) if (!urls.includes(u)) urls.push(u);
  }
  const fallidas = tandas.filter((t) => t.status === 'rejected');
  if (fallidas.length === tandas.length) {
    throw new Error(`ninguna búsqueda salió adelante: ${fallidas[0].reason?.message || 'motivo desconocido'}`);
  }
  return { urls, consultas: tandas.length, consultas_fallidas: fallidas.length };
}

// --- 2. Extracción ----------------------------------------------------------------

function* jsonLdNodes($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      continue;
    }
    const pila = [data];
    while (pila.length) {
      const n = pila.pop();
      if (Array.isArray(n)) pila.push(...n);
      else if (n && typeof n === 'object') {
        if (n['@graph']) pila.push(n['@graph']);
        yield n;
      }
    }
  }
}

function esProducto(n) {
  const t = n['@type'];
  const tipos = Array.isArray(t) ? t : [t];
  return tipos.some((x) => typeof x === 'string' && /product|offer/i.test(x));
}

// Las propiedades sueltas de schema.org (color, material, size, weight…) son justo las
// "variables del producto" que el usuario va a revisar en el ticket.
const PROPS = {
  brand: 'marca',
  color: 'color',
  material: 'material',
  size: 'talla',
  model: 'modelo',
  sku: 'sku',
  gtin13: 'codigo_barras',
  category: 'categoria',
  countryOfOrigin: 'origen',
};

function textoDe(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textoDe(v[0]);
  if (typeof v === 'object') return textoDe(v.name ?? v.value ?? v['@value']);
  return null;
}

function desdeJsonLd($, url) {
  for (const n of jsonLdNodes($)) {
    if (!esProducto(n)) continue;
    const offers = Array.isArray(n.offers) ? n.offers[0] : n.offers;
    const price = parsePrecio(offers?.price ?? offers?.lowPrice ?? n.price);
    if (!price) continue;

    const attributes = {};
    for (const [prop, nombre] of Object.entries(PROPS)) {
      const v = textoDe(n[prop]);
      if (v) attributes[nombre] = v;
    }
    const peso = textoDe(n.weight);
    if (peso) Object.assign(attributes, { peso }, parseCantidad(peso));
    if (offers?.availability) attributes.disponibilidad = String(offers.availability).replace(/^.*\//, '');

    return candidato({
      title: textoDe(n.name) || $('title').text(),
      price,
      currency: offers?.priceCurrency || parseMoneda($('body').text().slice(0, 400)),
      merchant: textoDe(offers?.seller) || new URL(url).hostname.replace(/^www\./, ''),
      url,
      source: `${id}:json-ld`,
      attributes,
    });
  }
  return null;
}

function desdeMeta($, url) {
  const meta = (sel) => $(sel).attr('content') || null;
  const price = parsePrecio(
    meta('meta[property="product:price:amount"]') ||
      meta('meta[property="og:price:amount"]') ||
      $('[itemprop="price"]').attr('content') ||
      $('[itemprop="price"]').first().text()
  );
  if (!price) return null;
  const attributes = {};
  const marca = meta('meta[property="product:brand"]') || $('[itemprop="brand"]').first().text();
  if (limpiar(marca)) attributes.marca = limpiar(marca);
  return candidato({
    title: meta('meta[property="og:title"]') || $('title').text(),
    price,
    currency:
      meta('meta[property="product:price:currency"]') ||
      meta('meta[property="og:price:currency"]') ||
      parseMoneda($('body').text().slice(0, 400)),
    merchant: meta('meta[property="og:site_name"]') || new URL(url).hostname.replace(/^www\./, ''),
    url,
    source: `${id}:meta`,
    attributes,
  });
}

// Texto legible de la página, recortado: lo que se le pasa al LLM cuando el HTML no
// declara nada estructurado.
function textoLimpio($) {
  $('script, style, noscript, svg, header, footer, nav').remove();
  return limpiar($('body').text()).slice(0, 4000);
}

async function desdeLlm($, url, intent) {
  const extraido = await llm.extractProduct(textoLimpio($), intent);
  const price = parsePrecio(extraido?.price);
  if (!price) return null;
  return candidato({
    // El LLM a veces devuelve título vacío en páginas de listado; el <title> de la página
    // siempre dice algo, y un candidato sin nombre es ilegible en el ticket.
    title: extraido.title || $('title').text() || new URL(url).hostname,
    price,
    currency: extraido.currency || 'USD',
    merchant: new URL(url).hostname.replace(/^www\./, ''),
    url,
    source: `${id}:llm`,
    attributes: extraido.attributes || {},
  });
}

// El gramaje casi nunca está en el JSON-LD, pero sí en el título: "Café molido natural
// Carrefour Classic 500 g". Se deriva de ahí solo si la tienda no lo declaró ya — un dato
// estructurado siempre gana a uno deducido del texto.
function enriquecerDesdeTitulo(c) {
  if (!c) return c;
  const derivados = parseCantidad(c.title);
  const attributes = { ...c.attributes };
  for (const [k, v] of Object.entries(derivados)) {
    if (attributes[k] === undefined) attributes[k] = v;
  }
  return { ...c, attributes };
}

async function extraer(url, intent) {
  if (!(await permitido(url))) return { url, ok: false, motivo: 'robots.txt lo prohíbe' };
  let html;
  try {
    html = await getText(url);
  } catch (e) {
    return { url, ok: false, motivo: e.message };
  }
  const $ = cheerio.load(html);
  let c = desdeJsonLd($, url) || desdeMeta($, url);
  if (!c) {
    try {
      c = await desdeLlm($, url, intent);
    } catch (e) {
      return { url, ok: false, motivo: `sin datos estructurados y el LLM falló: ${e.message}` };
    }
  }
  return c ? { url, ok: true, candidato: enriquecerDesdeTitulo(c) } : { url, ok: false, motivo: 'la página no declara precio' };
}

// --- 3. Orquestación del adaptador -------------------------------------------------

async function search(intent) {
  const query = [intent.query, ...Object.values(intent.attributes || {}).filter((v) => typeof v === 'string')]
    .filter(Boolean)
    .join(' ')
    .slice(0, 120);
  const { urls: encontradas, consultas, consultas_fallidas } = await buscarTodas(query);
  const urls = encontradas.slice(0, MAX_PAGINAS);
  const paginas = await Promise.all(
    urls.map(async (u) => {
      const r = await conLimite(extraer(u, intent), MS_POR_PAGINA);
      return r.vencida ? { url: u, ok: false, motivo: `no respondió en ${MS_POR_PAGINA / 1000}s` } : r;
    })
  );
  return {
    candidates: paginas.filter((p) => p.ok).map((p) => p.candidato),
    meta: {
      query,
      consultas,
      consultas_fallidas,
      urls_encontradas: encontradas.length,
      paginas_visitadas: urls.length,
      descartadas: paginas.filter((p) => !p.ok).map((p) => ({ url: p.url, motivo: p.motivo })),
    },
  };
}

module.exports = { id, productTypes, search };
