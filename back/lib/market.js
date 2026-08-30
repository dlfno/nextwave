// Estadísticas del mercado observado. Determinista y sin LLM: es lo que permite juzgar
// si una petición es razonable aunque OpenAI no responda (el LLM redacta, los números
// mandan — mismo principio que el resto del sistema).

function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  const i = (ordenados.length - 1) * p;
  const bajo = Math.floor(i);
  const alto = Math.ceil(i);
  if (bajo === alto) return ordenados[bajo];
  return ordenados[bajo] + (ordenados[alto] - ordenados[bajo]) * (i - bajo);
}

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function stats(candidates) {
  const precios = candidates.map((c) => c.price).filter((p) => typeof p === 'number' && p > 0).sort((a, b) => a - b);
  if (!precios.length) return { n: 0 };
  return {
    n: precios.length,
    min: r2(precios[0]),
    p10: r2(percentil(precios, 0.1)),
    mediana: r2(percentil(precios, 0.5)),
    p90: r2(percentil(precios, 0.9)),
    max: r2(precios[precios.length - 1]),
    monedas: [...new Set(candidates.map((c) => c.currency).filter(Boolean))],
  };
}

// ¿Cuántos de los ítems observados cumplirían de verdad la spec y el techo de precio?
// Es la pregunta que importa: no "¿el precio es bajo?" sino "¿existe algo comprable así?".
function coincidencias(candidates, spec, maxAmount) {
  const { evaluate } = require('./spec');
  return candidates.filter((c) => {
    if (maxAmount != null && (c.price == null || c.price > maxAmount)) return false;
    const checks = evaluate(spec, { ...c.attributes, price: c.price });
    return checks.every((k) => k.ok);
  });
}

// Veredicto determinista de razonabilidad. El LLM lo redactará después en lenguaje
// humano, pero nunca puede cambiar este dictamen ni inventar uno cuando no responde.
function assess({ candidates, spec, max_amount }) {
  const s = stats(candidates);
  if (!s.n) {
    return {
      verdict: 'sin_evidencia',
      reason: 'La investigación no encontró ninguna oferta con precio para comparar.',
      stats: s,
      matches: 0,
      recommendations: [],
    };
  }

  const viables = coincidencias(candidates, spec, max_amount);
  const recommendations = [];

  if (viables.length > 0) {
    return {
      verdict: 'ok',
      reason: `${viables.length} de ${s.n} ofertas observadas cumplen lo que pides.`,
      stats: s,
      matches: viables.length,
      ejemplos: viables.slice(0, 3).map((c) => ({ title: c.title, price: c.price, merchant: c.merchant })),
      recommendations,
    };
  }

  // Nada encaja: hay que decir exactamente qué habría que mover, con el número concreto.
  const porPrecio = coincidencias(candidates, spec, null);
  if (max_amount != null && porPrecio.length > 0) {
    const minViable = Math.min(...porPrecio.map((c) => c.price));
    recommendations.push({
      field: 'max_amount',
      suggested: r2(minViable),
      text: `Nada cumple tus condiciones por menos de $${max_amount}. La opción más barata que sí las cumple cuesta $${r2(minViable)}.`,
    });
  } else if (max_amount != null && max_amount < s.min) {
    recommendations.push({
      field: 'max_amount',
      suggested: s.p10,
      text: `Tu tope de $${max_amount} está por debajo de todo lo observado (el más barato cuesta $${s.min}). Con $${s.p10} entrarías en el 10% más barato del mercado.`,
    });
  }

  // Restricciones que ningún ítem del mercado cumple: probablemente sobran o están mal escritas
  const { evaluate } = require('./spec');
  for (const c of spec) {
    const cumplen = candidates.filter((x) => evaluate([c], { ...x.attributes, price: x.price })[0].ok).length;
    if (cumplen === 0) {
      recommendations.push({
        field: 'spec',
        constraint: c,
        text: `Ninguna de las ${s.n} ofertas observadas cumple "${require('./spec').describe(c)}".`,
      });
    }
  }

  if (!recommendations.length) {
    recommendations.push({
      field: 'spec',
      text: `Las condiciones son satisfacibles por separado pero ninguna oferta las cumple todas a la vez. Relaja la menos importante.`,
    });
  }

  return {
    verdict: 'adjust',
    reason: `Ninguna de las ${s.n} ofertas observadas cumple todo lo que pides.`,
    stats: s,
    matches: 0,
    recommendations,
  };
}

module.exports = { stats, coincidencias, assess };
