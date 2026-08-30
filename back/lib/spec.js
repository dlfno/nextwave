// Motor de restricciones del Intent Mandate. Reemplaza al viejo lib/conditions.js, que
// tenía cableados los campos de un vuelo (destination, price_below).
//
// Una spec es una lista de restricciones tipadas: [{attr, op, value}]. El motor las evalúa
// contra los atributos del ítem que el agente quiere comprar. Es 100% determinista y no
// consulta al LLM: el LLM propone la spec al redactar el ticket, el motor la dispone.

const { db } = require('../db');

// Comparación tolerante para texto: sin acentos, sin mayúsculas, sin espacios sobrantes.
// Un mandato que dice "Córdoba" tiene que casar con un catálogo que escribe "Cordoba".
function normText(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function normNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Cada fuente nombra lo mismo distinto: el catálogo de VuelaYa escribe "destination",
// Open Food Facts "marca" y el LLM a veces "precio". El motor trabaja sobre nombres
// canónicos para que un mandato firmado siga verificándose aunque la oferta venga de otra
// fuente que la que se investigó.
const ALIAS = {
  price: 'price', precio: 'price', importe: 'price', costo: 'price', coste: 'price',
  marca: 'marca', brand: 'marca', fabricante: 'marca',
  destino: 'destino', destination: 'destino',
  origen: 'origen', origin: 'origen',
  aerolinea: 'aerolinea', airline: 'aerolinea', carrier: 'aerolinea',
  gramaje: 'gramaje_g', gramaje_g: 'gramaje_g', gramos: 'gramaje_g', peso: 'gramaje_g', weight: 'gramaje_g',
  volumen: 'volumen_ml', volumen_ml: 'volumen_ml',
  talla: 'talla', size: 'talla', tamano: 'talla',
  color: 'color', colour: 'color',
  cantidad: 'cantidad', quantity: 'cantidad',
  escalas: 'escalas', stops: 'escalas',
};

function canonAttr(nombre) {
  const n = normText(nombre).replace(/\s+/g, '_');
  return ALIAS[n] || n;
}

// Busca el atributo por su nombre canónico. Nada de casar por prefijo: "precio" llegó a
// resolverse contra "precio_observado", que es una fecha, y el check comparaba una fecha
// con un número. Si el nombre no casa, el atributo simplemente no está.
function getAttr(attributes, attr) {
  if (attributes == null) return undefined;
  if (attr in attributes) return attributes[attr];
  const want = canonAttr(attr);
  for (const k of Object.keys(attributes)) {
    if (canonAttr(k) === want) return attributes[k];
  }
  return undefined;
}

const NUMERIC = new Set(['lt', 'lte', 'gt', 'gte', 'between']);

const OPS = {
  eq: (a, b) => normText(a) === normText(b),
  neq: (a, b) => normText(a) !== normText(b),
  contains: (a, b) => normText(a).includes(normText(b)),
  in: (a, b) => (Array.isArray(b) ? b : [b]).some((x) => normText(a) === normText(x)),
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  between: (a, b) => a >= b[0] && a <= b[1],
};

const SIMBOLO = { eq: '=', neq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', in: '∈', contains: '⊃', between: '∈' };

function describe(c) {
  const val = Array.isArray(c.value) ? c.value.join(c.op === 'between' ? '–' : ', ') : c.value;
  return `${c.attr} ${SIMBOLO[c.op] || c.op} ${val}`;
}

// Evalúa una spec contra los atributos de un intento de compra.
// Devuelve [{name, ok, detail}] — todos deben pasar para que la compra siga adelante.
function evaluate(spec, attributes) {
  const list = Array.isArray(spec) ? spec : [];
  return list.map((c) => {
    const raw = getAttr(attributes, c.attr);
    const name = `condición: ${describe(c)}`;

    // Atributo ausente = no verificable. No se aprueba lo que no se puede comprobar:
    // un ítem sin gramaje no cumple "gramaje ≥ 500 g", falla el check.
    if (raw === undefined || raw === null || raw === '') {
      return { name, ok: false, detail: `el ítem no declara "${c.attr}"` };
    }

    const fn = OPS[c.op];
    if (!fn) return { name, ok: false, detail: `operador "${c.op}" no soportado` };

    if (NUMERIC.has(c.op)) {
      const a = normNum(raw);
      const b = c.op === 'between' ? (c.value || []).map(normNum) : normNum(c.value);
      const bad = a === null || (c.op === 'between' ? b.length !== 2 || b.some((x) => x === null) : b === null);
      if (bad) return { name, ok: false, detail: `valor no numérico: "${raw}"` };
      return { name, ok: fn(a, b), detail: `${c.attr} = ${a}` };
    }

    return { name, ok: fn(raw, c.value), detail: `${c.attr} = "${raw}"` };
  });
}

// Tope de frecuencia: vive en su propia columna porque necesita contar el historial,
// no los atributos del ítem.
function frequencyCheck(mandate) {
  if (mandate.max_uses_per_month == null) return null;
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM purchases
       WHERE mandate_id = ? AND status = 'approved'
         AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
    )
    .get(mandate.id);
  return {
    name: `condición: máx. ${mandate.max_uses_per_month} compras/mes`,
    ok: n < mandate.max_uses_per_month,
    detail: `${n} compras este mes`,
  };
}

// Valida y limpia una spec venida del LLM o del formulario del ticket antes de firmarla.
// Lo que no se entiende se descarta: un mandato nunca se firma con una restricción que el
// motor no sabría evaluar después.
function sanitize(spec) {
  if (!Array.isArray(spec)) return [];
  const out = [];
  for (const c of spec) {
    if (!c || typeof c.attr !== 'string' || !c.attr.trim()) continue;
    const op = String(c.op || '').trim();
    if (!OPS[op]) continue;
    let value = c.value;
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) continue;
      value = value.map(normNum);
      if (value.some((v) => v === null)) continue;
    } else if (NUMERIC.has(op)) {
      value = normNum(value);
      if (value === null) continue;
    } else if (op === 'in') {
      value = (Array.isArray(value) ? value : [value]).map((v) => String(v)).filter(Boolean);
      if (!value.length) continue;
    } else {
      if (value === null || value === undefined || String(value).trim() === '') continue;
      value = String(value).trim();
      // "500" y 500 tienen que ser el mismo valor: si no, un gramaje escrito como texto
      // en el ticket se compararía como cadena contra un número del catálogo.
      if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    }
    out.push({ attr: c.attr.trim(), op, value });
  }
  return out;
}

module.exports = { evaluate, frequencyCheck, sanitize, describe, getAttr, canonAttr, normText, normNum, OPS };
