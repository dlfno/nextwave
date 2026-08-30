// Orquestador del scraping. Corre los adaptadores que aplican al tipo de producto, en
// paralelo, y devuelve un snapshot congelado con hash.
//
// Dos reglas que no se negocian:
//   1. El fallo de una fuente nunca tumba la investigación: se registra como fuente en
//      estado "error" y el ticket lo enseña. La evidencia dice la verdad sobre sí misma.
//   2. El snapshot se hashea. Ese hash entra en el payload que el Wallet firma, así que
//      el auditor puede replayear la decisión contra exactamente lo que se vio.
//   3. Lo que no es el producto pedido no cuenta como oferta: pasa por el filtro de
//      relevancia antes de entrar en las estadísticas (DECISIONS #32).

const { sha256, canonical } = require('../lib/crypto');
const cache = require('./cache');
const fx = require('./fx');
const relevance = require('../lib/relevance');
const market = require('../lib/market');

// Ninguna fuente de producto necesita API key ni tiene un proveedor que pueda apagarla
// (DECISIONS #31, #32): datos abiertos, la web abierta y el catálogo del propio merchant.
// fx.js sí llama a una API, pero eso es tipo de cambio, no dato de producto.
const ADAPTERS = [
  require('./adapters/catalog'),
  require('./adapters/openfoodfacts'),
  require('./adapters/web'),
];

// El adaptador 'generic' entra siempre que no haya uno específico con resultados; el de
// catálogo entra siempre porque es la tienda donde se comprará de verdad.
function adaptadoresPara(productType) {
  const especificos = ADAPTERS.filter((a) => a.productTypes.includes(productType));
  const genericos = ADAPTERS.filter((a) => a.productTypes.includes('generic') && !especificos.includes(a));
  return [...especificos, ...genericos];
}

// Tope por adaptador. Sin esto una fuente lenta marca el tiempo del ticket entero: el
// adaptador web llegó a tardar 41s visitando páginas, con el usuario esperando delante.
const LIMITE_MS = Number(process.env.SCRAPE_ADAPTER_MS || 25000);

function conLimite(promesa, ms, quien) {
  let timer;
  const limite = new Promise((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error(`${quien} superó el límite de ${ms / 1000}s`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

async function correr(adapter, intent) {
  const t0 = Date.now();
  try {
    const { candidates = [], meta = {} } = await conLimite(adapter.search(intent), LIMITE_MS, adapter.id);
    return {
      source: adapter.id,
      status: 'ok',
      ms: Date.now() - t0,
      n: candidates.length,
      meta,
      candidates: candidates.filter((c) => c.price != null),
    };
  } catch (e) {
    return {
      source: adapter.id,
      status: e.skip ? 'no_configurado' : 'error',
      ms: Date.now() - t0,
      n: 0,
      error: e.message,
      candidates: [],
    };
  }
}

// Investiga una intención y devuelve el snapshot. `intent` es {product_type, query,
// attributes, currency}. Cacheado por TTL: el front polea el ticket cada 2s y no puede
// disparar una salida a internet por poll.
async function research(intent) {
  const key = cache.key('research', intent.product_type, intent.query || '', intent.attributes || {});
  return cache.through(key, async () => {
    const adapters = adaptadoresPara(intent.product_type);
    const resultados = await Promise.all(adapters.map((a) => correr(a, intent)));

    // Primero relevancia: una oferta que no es el producto pedido no puede contar en el
    // mercado. Sin este paso la mediana salía de mayonesa cuando se pedía café.
    const crudos = resultados.flatMap((r) => r.candidates);
    const { relevantes, descartados, terminos } = relevance.filter(crudos, intent.query || '');

    // Después la moneda: los precios llegan en la de cada tienda y hay que llevarlos todos
    // a la misma, o el "mercado" sería una suma de manzanas y peras.
    const { candidates, fx: conversion } = await fx.normalizar(relevantes, intent.currency || 'USD');

    const sources = resultados.map(({ candidates: _, ...resto }) => resto);
    const snapshot = {
      intent,
      fetched_at: new Date().toISOString(),
      currency: intent.currency || 'USD',
      fx: conversion,
      // Lo descartado también es evidencia: el ticket enseña cuánto se tiró y por qué
      relevancia: { terminos, descartados, encontrados: crudos.length, relevantes: relevantes.length },
      sources,
      candidates,
      stats: market.stats(candidates),
    };
    return { ...snapshot, hash: sha256(canonical({ ...snapshot, fetched_at: undefined })) };
  });
}

module.exports = { research, adaptadoresPara };
