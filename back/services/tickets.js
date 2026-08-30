const { db } = require('../db');
const audit = require('../lib/audit');
const llm = require('../lib/llm');
const spec = require('../lib/spec');
const market = require('../lib/market');
const scraper = require('../scraper');
const { createMandate } = require('./mandates');

// Ticket de mandato: el circuito completo entre "quiero unos tenis" y una firma Ed25519.
//
//   petición en lenguaje natural
//     → intención estructurada        (LLM, con fallback determinista)
//     → scraping REAL del producto    (scraper/, snapshot con hash)
//     → juicio de razonabilidad       (market.assess: determinista; el LLM solo redacta)
//     → ticket editable               (el usuario cambia variables, firma o sigue chateando)
//     → mandato firmado
//
// El LLM nunca bloquea la firma: si dice que la petición no es razonable, el ticket sale
// con la advertencia y el botón sigue vivo. Firmar contra la recomendación queda auditado
// (DECISIONS #25).

// --- Intención: LLM con fallback determinista --------------------------------------

const PALABRAS_VUELO = /\b(vuelo|vuelos|avi[oó]n|volar|pasaje|boleto de avi[oó]n)\b/i;
const PALABRAS_SUPER = /\b(caf[eé]|leche|aceite|az[uú]car|arroz|pasta|cereal|galletas|yogur|chocolate|harina|at[uú]n|refresco|agua|snack)\b/i;

function finDeMes() {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sin API key el sistema sigue funcionando: se extrae lo estructuralmente reconocible
// (precio, destino, frecuencia) y el resto queda en null para que el usuario lo complete
// en el ticket. Nunca se adivina.
function intentFallback(text) {
  const t = String(text || '');
  const precio = t.match(/(?:menos de|bajo|por debajo de|hasta|máx\.?|maximo|máximo|<)\s*\$?\s*(\d[\d.,]*)/i) || t.match(/\$\s*(\d[\d.,]*)/);
  const max_amount = precio ? Number(precio[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')) : null;
  const destino = t.match(/\ba\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)/);
  const veces = t.match(/(\d+)\s*(?:veces?|compras?)\s*(?:al|por)\s*mes/i);

  const product_type = PALABRAS_VUELO.test(t) ? 'flights' : PALABRAS_SUPER.test(t) ? 'groceries' : 'generic';
  const attributes = {};
  if (product_type === 'flights' && destino) attributes.destino = destino[1];

  const constraints = [];
  if (max_amount) constraints.push({ attr: 'price', op: 'lt', value: max_amount });
  if (attributes.destino) constraints.push({ attr: 'destination', op: 'eq', value: attributes.destino });

  return {
    product_type,
    query: t.slice(0, 120),
    attributes,
    spec: constraints,
    max_amount,
    total_budget: max_amount ? max_amount * (veces ? Number(veces[1]) : 1) : null,
    max_uses_per_month: veces ? Number(veces[1]) : null,
    valid_until: finDeMes(),
    currency: 'USD',
  };
}

// Lo que el usuario describió del producto ("marca Carrefour", "500 gramos") llega en
// `attributes` como pista para el scraping. Si no acaba también en la spec, el mandato
// firmado no restringiría la marca ni el gramaje: el agente podría comprar cualquier cosa
// de esa categoría. Se promueven a condición, y el usuario puede quitarlas en el ticket.
function promoverAtributos(attributes, base) {
  const yaEsta = (attr) => base.some((c) => spec.canonAttr(c.attr) === spec.canonAttr(attr));
  const extra = [];
  for (const [attr, value] of Object.entries(attributes || {})) {
    if (value === null || value === undefined || value === '' || typeof value === 'object') continue;
    if (yaEsta(attr)) continue;
    extra.push({ attr, op: 'eq', value });
  }
  return spec.sanitize([...base, ...extra]);
}

function normalizarIntent(raw, text) {
  const base = intentFallback(text);
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const out = {
    product_type: ['flights', 'groceries', 'generic'].includes(raw?.product_type) ? raw.product_type : base.product_type,
    query: String(raw?.query || base.query).slice(0, 200),
    attributes: raw?.attributes && typeof raw.attributes === 'object' ? raw.attributes : base.attributes,
    spec: spec.sanitize(raw?.spec).length ? spec.sanitize(raw.spec) : base.spec,
    max_amount: num(raw?.max_amount) ?? base.max_amount,
    total_budget: num(raw?.total_budget),
    max_uses_per_month: num(raw?.max_uses_per_month) ?? base.max_uses_per_month,
    valid_until: /^\d{4}-\d{2}-\d{2}$/.test(raw?.valid_until || '') ? raw.valid_until : base.valid_until,
    currency: String(raw?.currency || 'USD').slice(0, 3).toUpperCase(),
  };
  out.spec = promoverAtributos(out.attributes, out.spec);
  // Misma regla que el prompt, aplicada de forma determinista por si el LLM la ignoró
  if (!out.total_budget && out.max_amount) out.total_budget = out.max_amount * (out.max_uses_per_month || 1);
  return out;
}

// --- Lectura ------------------------------------------------------------------------

function row(id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

function parse(r) {
  if (!r) return null;
  return {
    ...r,
    intent: JSON.parse(r.intent_json || '{}'),
    evidence: JSON.parse(r.evidence_json || '{}'),
    feasibility: JSON.parse(r.feasibility_json || '{}'),
    draft: JSON.parse(r.draft_json || '{}'),
    chat: JSON.parse(r.chat_json || '[]'),
  };
}

// Los valores que el scraping observó para cada atributo. Es lo que convierte el ticket
// en algo revisable: el usuario ve "aerolínea: AeroSur, VuelaFlex, PataAir" y elige,
// en vez de escribir a ciegas.
function observado(candidates, attr) {
  const vistos = candidates
    .map((c) => spec.getAttr({ ...c.attributes, price: c.price }, attr))
    .filter((v) => v !== undefined && v !== null && v !== '');
  const unicos = [...new Set(vistos.map((v) => (typeof v === 'number' ? v : String(v))))];
  return { n: vistos.length, valores: unicos.slice(0, 8) };
}

// Metadatos de la evidencia, no características del producto: ofrecerlos como condición
// del mandato no tiene sentido (y "precio_observado" es una fecha — justo la trampa que ya
// rompió el motor una vez, ver DECISIONS #28).
const NO_ES_CONDICION = new Set(['precio_observado', 'observaciones_de_precio', 'precio_original']);

// Vista del ticket tal como la consume el front: variables editables + evidencia + veredicto.
function view(r) {
  const t = parse(r);
  if (!t) return null;
  const candidates = t.evidence.candidates || [];
  return {
    id: t.id,
    status: t.status,
    request_text: t.request_text,
    product_type: t.product_type,
    error: t.error,
    created_at: t.created_at,
    updated_at: t.updated_at,
    mandate_id: t.mandate_id,
    draft: t.draft,
    chat: t.chat,
    feasibility: t.feasibility,
    variables: (t.draft.spec || []).map((c) => ({ ...c, label: spec.describe(c), observado: observado(candidates, c.attr) })),
    // Atributos que el scraping encontró y el mandato todavía NO restringe: el usuario
    // puede añadirlos como condición con un clic.
    disponibles: [...new Set(candidates.flatMap((c) => Object.keys(c.attributes || {})))]
      .filter((a) => !NO_ES_CONDICION.has(a))
      .filter((a) => !(t.draft.spec || []).some((c) => spec.canonAttr(c.attr) === spec.canonAttr(a)))
      .map((a) => ({ attr: a, observado: observado(candidates, a) })),
    evidence: {
      hash: t.evidence_hash,
      fetched_at: t.evidence.fetched_at,
      cached: t.evidence.cached || false,
      stats: t.evidence.stats || { n: 0 },
      sources: t.evidence.sources || [],
      // Lo que se tiró por no ser el producto pedido: la evidencia también tiene que
      // rendir cuentas de lo que descartó (DECISIONS #32).
      relevancia: t.evidence.relevancia || null,
      samples: candidates.slice(0, 8).map((c) => ({
        title: c.title,
        price: c.price,
        currency: c.currency,
        merchant: c.merchant,
        url: c.url,
        source: c.source,
        attributes: c.attributes,
      })),
    },
  };
}

// --- Escritura ----------------------------------------------------------------------

function update(id, campos) {
  const sets = Object.keys(campos).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tickets SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...campos, id });
  return row(id);
}

function draftDesdeIntent(intent) {
  return {
    product_type: intent.product_type,
    query: intent.query,
    attributes: intent.attributes,
    spec: intent.spec,
    max_amount: intent.max_amount,
    total_budget: intent.total_budget,
    max_uses_per_month: intent.max_uses_per_month,
    valid_until: intent.valid_until,
    currency: intent.currency,
  };
}

// Evalúa el borrador contra la evidencia ya congelada. Barato y determinista: se puede
// llamar en cada edición del usuario sin volver a salir a internet.
async function evaluar(draft, evidence, { redactar = true } = {}) {
  const assessment = market.assess({
    candidates: evidence.candidates || [],
    spec: draft.spec || [],
    max_amount: draft.max_amount,
  });
  let source = 'deterministic';
  let text = assessment.reason;
  let source_error;
  if (redactar && llm.hasKey()) {
    try {
      text = await llm.draftFeasibility(assessment, draft);
      source = 'llm';
    } catch (e) {
      // El veredicto ya está decidido; solo perdemos la redacción. Se guarda el motivo:
      // el badge del front dice "determinista" y así se puede saber por qué.
      source_error = e.message;
    }
  }
  return { ...assessment, text, source, source_error };
}

function estadoPara(feasibility) {
  return feasibility.verdict === 'ok' ? 'ready' : 'needs_review';
}

// Paso 2 y 3 del circuito: investigar de verdad y juzgar si la petición es razonable.
// Corre en segundo plano — el front ya está poleando el ticket.
async function investigar(id) {
  const t = parse(row(id));
  if (!t) return;
  try {
    let intent;
    try {
      intent = normalizarIntent(await llm.extractIntent(t.request_text), t.request_text);
    } catch {
      intent = intentFallback(t.request_text);
    }
    update(id, { product_type: intent.product_type, intent_json: JSON.stringify(intent) });

    const evidence = await scraper.research({
      product_type: intent.product_type,
      query: intent.query,
      attributes: intent.attributes,
      currency: intent.currency,
    });

    const draft = draftDesdeIntent(intent);
    const feasibility = await evaluar(draft, evidence);

    update(id, {
      status: estadoPara(feasibility),
      evidence_json: JSON.stringify(evidence),
      evidence_hash: evidence.hash,
      draft_json: JSON.stringify(draft),
      feasibility_json: JSON.stringify(feasibility),
    });

    audit.append('wallet', 'ticket_researched', {
      ticket_id: id,
      product_type: intent.product_type,
      evidence_hash: evidence.hash,
      fuentes: evidence.sources.map((s) => ({ source: s.source, status: s.status, n: s.n })),
      ofertas: evidence.stats.n || 0,
      veredicto: feasibility.verdict,
    });
  } catch (e) {
    update(id, { status: 'failed', error: e.message });
    audit.append('wallet', 'ticket_research_failed', { ticket_id: id, error: e.message });
  }
}

function create(userId, text) {
  const info = db
    .prepare("INSERT INTO tickets (user_id, request_text, status) VALUES (?, ?, 'researching')")
    .run(userId, String(text).slice(0, 1000));
  const id = info.lastInsertRowid;
  audit.append('human', 'ticket_created', { ticket_id: id, request: String(text).slice(0, 300) });
  investigar(id); // en segundo plano: la ruta responde ya y el front polea
  return view(row(id));
}

// Vuelve a investigar: el usuario cambió qué producto quiere, no solo sus límites.
async function reinvestigar(id) {
  update(id, { status: 'researching' });
  await investigar(id);
  return view(row(id));
}

const NUMERICOS = ['max_amount', 'total_budget', 'max_uses_per_month'];

// Edición del ticket por el usuario. Todo lo que entra se sanea: la spec pasa por
// spec.sanitize() para que no se pueda firmar una condición que el motor no sabría evaluar.
async function patch(id, cambios) {
  const t = parse(row(id));
  if (!t) return null;
  const draft = { ...t.draft };

  if (cambios.spec !== undefined) draft.spec = spec.sanitize(cambios.spec);
  for (const k of NUMERICOS) {
    if (cambios[k] === undefined) continue;
    const n = Number(cambios[k]);
    draft[k] = cambios[k] === null || cambios[k] === '' ? null : Number.isFinite(n) && n > 0 ? n : draft[k];
  }
  if (cambios.valid_until && /^\d{4}-\d{2}-\d{2}$/.test(cambios.valid_until)) draft.valid_until = cambios.valid_until;
  if (cambios.query) draft.query = String(cambios.query).slice(0, 200);

  const feasibility = await evaluar(draft, t.evidence);
  update(id, {
    draft_json: JSON.stringify(draft),
    feasibility_json: JSON.stringify(feasibility),
    status: estadoPara(feasibility),
  });
  audit.append('human', 'ticket_edited', { ticket_id: id, cambios, veredicto: feasibility.verdict });
  return view(row(id));
}

// Seguir conversando sobre el ticket. El LLM propone un parche; lo aplica el servidor
// tras sanearlo, y la razonabilidad se recalcula contra la evidencia real.
async function chat(id, mensaje) {
  const t = parse(row(id));
  if (!t) return null;
  const historial = [...t.chat, { role: 'user', content: String(mensaje).slice(0, 1000) }];

  let reply;
  let aplicado = null;
  try {
    const out = await llm.chatTicket(historial, {
      draft: t.draft,
      summary: { stats: t.evidence.stats, feasibility: t.feasibility, muestras: (t.evidence.candidates || []).slice(0, 5) },
    });
    reply = String(out.reply || '');
    if (out.patch && Object.keys(out.patch).length) aplicado = out.patch;
  } catch {
    reply = 'No pude consultar al modelo ahora mismo. Puedes editar las variables del ticket a mano y firmarlo igual.';
  }

  update(id, { chat_json: JSON.stringify([...historial, { role: 'assistant', content: reply }]) });
  if (aplicado) await patch(id, aplicado);
  return { ...view(row(id)), applied_patch: aplicado };
}

function firmable(draft) {
  const faltan = [];
  if (!draft.max_amount) faltan.push('max_amount');
  if (!draft.valid_until) faltan.push('valid_until');
  return faltan;
}

// Firma. El veredicto del LLM no es un veto: si el usuario firma contra la
// recomendación, se firma igual y el trail lo dice.
function sign(id) {
  const t = parse(row(id));
  if (!t) throw new Error('el ticket no existe');
  if (t.status === 'signed') throw new Error('este ticket ya fue firmado');
  const faltan = firmable(t.draft);
  if (faltan.length) throw new Error(`faltan campos obligatorios: ${faltan.join(', ')}`);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id);
  const agent = db.prepare('SELECT * FROM agents WHERE is_rogue = 0 AND user_id = ? LIMIT 1').get(user.id);
  const pm = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(user.id);

  const contraRecomendacion = t.feasibility.verdict === 'adjust' || t.feasibility.verdict === 'sin_evidencia';
  if (contraRecomendacion) {
    audit.append('human', 'mandate_signed_against_recommendation', {
      ticket_id: id,
      veredicto: t.feasibility.verdict,
      motivo: t.feasibility.reason,
      recomendaciones: t.feasibility.recommendations,
    });
  }

  const mandate = createMandate({
    user_id: user.id,
    agent_id: agent.id,
    payment_method_id: pm.id,
    ticket_id: id,
    product_type: t.draft.product_type,
    spec: spec.sanitize(t.draft.spec),
    evidence_hash: t.evidence_hash,
    max_amount: t.draft.max_amount,
    total_budget: t.draft.total_budget || t.draft.max_amount,
    max_uses_per_month: t.draft.max_uses_per_month || null,
    valid_from: new Date().toISOString(),
    valid_until: new Date(t.draft.valid_until + 'T23:59:59').toISOString(),
    nl_text: t.request_text,
  });

  update(id, { status: 'signed', mandate_id: mandate.id });
  return { ticket: view(row(id)), mandate, against_recommendation: contraRecomendacion };
}

function list(limit = 20) {
  return db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT ?').all(limit).map(view);
}

function discard(id) {
  update(id, { status: 'discarded' });
  audit.append('human', 'ticket_discarded', { ticket_id: id });
  return view(row(id));
}

module.exports = { create, view, row, list, patch, chat, sign, discard, reinvestigar, intentFallback };
