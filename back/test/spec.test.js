const test = require('node:test');
const assert = require('node:assert');

const spec = require('../lib/spec');
const market = require('../lib/market');
const relevance = require('../lib/relevance');

// El motor de spec es lo único que decide si una compra agéntica cumple el mandato.
// Estas pruebas cubren los casos que ya rompieron algo de verdad durante el desarrollo.

test('compara números aunque el atributo llegue como texto', () => {
  const [c] = spec.evaluate([{ attr: 'price', op: 'lt', value: 200 }], { price: '189,00' });
  assert.equal(c.ok, true);
});

test('el texto casa sin acentos ni mayúsculas', () => {
  const [c] = spec.evaluate([{ attr: 'destino', op: 'eq', value: 'Cordoba' }], { destino: 'CÓRDOBA' });
  assert.equal(c.ok, true);
});

test('los alias resuelven el mismo atributo en distintos idiomas', () => {
  const attrs = { destination: 'Córdoba', airline: 'AeroSur', price: 189 };
  const checks = spec.evaluate(
    [
      { attr: 'destino', op: 'eq', value: 'Córdoba' },
      { attr: 'aerolinea', op: 'eq', value: 'AeroSur' },
      { attr: 'precio', op: 'lt', value: 200 },
    ],
    attrs
  );
  assert.deepEqual(checks.map((c) => c.ok), [true, true, true]);
});

// El bug: "precio" casaba por prefijo con "precio_observado", que es una fecha, y el
// check comparaba una fecha contra un número dando por bueno lo que no lo era.
test('no casa un atributo por prefijo con otro que solo comparte el principio', () => {
  const [c] = spec.evaluate([{ attr: 'precio', op: 'lt', value: 6 }], { precio_observado: '2026-08-27' });
  assert.equal(c.ok, false);
  assert.match(c.detail, /no declara/);
});

test('un atributo ausente nunca aprueba: no se verifica lo que no está', () => {
  const [c] = spec.evaluate([{ attr: 'gramaje_g', op: 'gte', value: 500 }], { marca: 'Nike' });
  assert.equal(c.ok, false);
});

test('sanitize descarta operadores inventados y normaliza números escritos como texto', () => {
  const limpio = spec.sanitize([
    { attr: 'gramaje_g', op: 'eq', value: '500' },
    { attr: 'marca', op: 'aproximadamente', value: 'Nike' },
    { attr: '', op: 'eq', value: 'x' },
    { attr: 'price', op: 'between', value: [10, 20] },
  ]);
  assert.deepEqual(limpio, [
    { attr: 'gramaje_g', op: 'eq', value: 500 },
    { attr: 'price', op: 'between', value: [10, 20] },
  ]);
});

test('el veredicto de razonabilidad es "ok" cuando alguna oferta cumple todo', () => {
  const candidates = [
    { title: 'a', price: 5, currency: 'USD', attributes: { marca: 'Carrefour', gramaje_g: 500 } },
    { title: 'b', price: 9, currency: 'USD', attributes: { marca: 'Otra', gramaje_g: 500 } },
  ];
  const r = market.assess({ candidates, spec: [{ attr: 'marca', op: 'eq', value: 'Carrefour' }], max_amount: 6 });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.matches, 1);
});

test('cuando el tope de precio es lo que estorba, se recomienda el mínimo real que sí cumple', () => {
  const candidates = [
    { title: 'a', price: 9, currency: 'USD', attributes: { marca: 'Carrefour' } },
    { title: 'b', price: 12, currency: 'USD', attributes: { marca: 'Carrefour' } },
  ];
  const r = market.assess({ candidates, spec: [{ attr: 'marca', op: 'eq', value: 'Carrefour' }], max_amount: 6 });
  assert.equal(r.verdict, 'adjust');
  const rec = r.recommendations.find((x) => x.field === 'max_amount');
  assert.equal(rec.suggested, 9);
});

test('una condición que ninguna oferta cumple se señala por su nombre', () => {
  const candidates = [{ title: 'a', price: 5, currency: 'USD', attributes: { gramaje_g: 250 } }];
  const r = market.assess({ candidates, spec: [{ attr: 'gramaje_g', op: 'eq', value: 500 }], max_amount: 10 });
  assert.equal(r.verdict, 'adjust');
  assert.match(r.recommendations[0].text, /gramaje_g/);
});

test('sin ofertas observadas el veredicto es "sin_evidencia", no un falso "ok"', () => {
  const r = market.assess({ candidates: [], spec: [], max_amount: 10 });
  assert.equal(r.verdict, 'sin_evidencia');
});

// Filtro de relevancia: la evidencia tiene que ser del producto que se pidió.
// El caso que lo motivó está en DECISIONS #32.

test('el término principal separa el producto pedido de otro de la misma marca', () => {
  const q = 'cafe molido 500 gramos marca Carrefour';
  const { relevantes, descartados } = relevance.filter(
    [
      { title: 'Café molido natural Carrefour Classic 500 g', attributes: {} },
      { title: "Carrefour Classic' Mayonaise à la Moutarde", attributes: { marca: 'Carrefour' } },
      { title: 'Oeufs Bio - Carrefour Bio', attributes: { marca: 'Carrefour BIO' } },
    ],
    q
  );
  assert.equal(relevantes.length, 1);
  assert.equal(descartados.length, 2);
});

test('conserva el mismo producto de otra marca: eso sí es el mercado', () => {
  const { relevantes } = relevance.filter(
    [{ title: 'Cafe molido espresso Bustelo', attributes: { marca: 'Bustelo' } }],
    'cafe molido marca Carrefour'
  );
  assert.equal(relevantes.length, 1);
});

test('descarta otra categoría aunque comparta el destino', () => {
  const { relevantes, descartados } = relevance.filter(
    [
      { title: 'Vuelo Buenos Aires → Córdoba (AeroSur)', attributes: {} },
      { title: 'Hotel en Córdoba centro', attributes: {} },
    ],
    'vuelo a Córdoba si baja de 200 dolares'
  );
  assert.equal(relevantes.length, 1);
  assert.match(descartados[0].title, /Hotel/);
});

test('los términos ignoran unidades, números y ruido de compra', () => {
  assert.deepEqual(relevance.terms('quiero comprar cafe molido 500 gramos barato por menos de 6 dolares'), ['cafe', 'molido']);
});

test('sin términos discriminantes no se descarta nada', () => {
  const { relevantes } = relevance.filter([{ title: 'lo que sea', attributes: {} }], 'comprar barato');
  assert.equal(relevantes.length, 1);
});
